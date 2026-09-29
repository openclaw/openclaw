type Rect = { x: number; y: number; width: number; height: number };
type TimedCue = { start: number; end: number };
type CaptionCue = TimedCue & { kind: "caption"; text: string; image: string };
type ZoomCue = TimedCue & { kind: "zoom"; rect: Rect; factor: number; ease: number };
type SpeedCue = TimedCue & { kind: "speed"; factor: number };
export type ProofVideoCue = CaptionCue | ZoomCue | SpeedCue;
export type ProofVideoCues = {
  version: 1;
  video: string;
  viewport: { width: number; height: number };
  scale: number;
  captionHeight: number;
  cues: ProofVideoCue[];
};

function fail(message: string): never {
  throw new Error(`Invalid proof-video cues: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected an object");
  }
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    return fail(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}
function path(value: unknown, basename = false): value is string {
  return (
    typeof value === "string" &&
    value
      .split("/")
      .every(
        (part) => /^[^\\:]+$/.test(part) && !part.includes("\0") && part !== "." && part !== "..",
      ) &&
    (!basename || !value.includes("/"))
  );
}

export function validateProofVideoCues(input: unknown): asserts input is ProofVideoCues {
  const data = object(input);
  if (data.version !== 1 || !path(data.video, true)) {
    fail("version must be 1 and video must be a local basename");
  }
  const viewport = object(data.viewport);
  const width = number(viewport.width, "viewport.width", 2);
  const height = number(viewport.height, "viewport.height", 2);
  if (width % 2 || height % 2) {
    fail("viewport dimensions must be even integers for H.264");
  }
  if (number(data.scale, "scale") === 0) {
    fail("scale must be positive");
  }
  const cardHeight = number(data.captionHeight, "captionHeight", 1);
  if (!Number.isInteger(cardHeight) || cardHeight > height) {
    fail("captionHeight must be an integer no greater than viewport.height");
  }
  if (!Array.isArray(data.cues)) {
    fail("cues must be an array");
  }
  const intervals: Record<"zoom" | "speed", TimedCue[]> = { zoom: [], speed: [] };
  for (const value of data.cues) {
    const cue = object(value);
    const start = number(cue.start, "cue.start");
    const end = number(cue.end, "cue.end");
    if (end <= start) {
      fail("cue.end must be greater than cue.start");
    }
    if (cue.kind === "caption") {
      if (
        typeof cue.text !== "string" ||
        !cue.text.trim() ||
        !path(cue.image) ||
        !cue.image.endsWith(".png")
      ) {
        fail("captions need nonempty text and a safe relative image path");
      }
    } else if (cue.kind === "zoom" || cue.kind === "speed") {
      const factor = number(cue.factor, `${cue.kind}.factor`, cue.kind === "zoom" ? 1 : 0);
      if (!factor) {
        fail("speed.factor must be positive");
      }
      intervals[cue.kind].push({ start, end });
      if (cue.kind === "zoom") {
        if (factor > 10) {
          fail("zoom.factor cannot exceed zoompan's limit of 10");
        }
        number(cue.ease, "zoom.ease");
        const rect = object(cue.rect);
        const x = number(rect.x, "rect.x");
        const y = number(rect.y, "rect.y");
        const w = number(rect.width, "rect.width");
        const h = number(rect.height, "rect.height");
        if (!w || !h || x + w > width || y + h > height) {
          fail("zoom.rect must have positive dimensions and fit inside the viewport");
        }
      }
    } else {
      fail("cue.kind must be caption, zoom, or speed");
    }
  }
  for (const [kind, cues] of Object.entries(intervals)) {
    cues.sort((a, b) => a.start - b.start);
    let previousEnd = 0;
    for (const cue of cues) {
      if (cue.start < previousEnd) {
        fail(`${kind} cues must not overlap`);
      }
      previousEnd = cue.end;
    }
  }
}

export function planProofVideoRender(
  cues: ProofVideoCues,
  opts: { durationSeconds: number; fps: number },
): { inputs: string[]; filterComplex: string; outputMap: string; durationSeconds: number } {
  validateProofVideoCues(cues);
  const duration = number(opts.durationSeconds, "durationSeconds");
  const fps = number(opts.fps, "fps");
  if (!duration || !fps || cues.cues.some((cue) => cue.end > duration)) {
    fail("duration and fps must be positive, and cues must end within the video");
  }
  const speeds = cues.cues
    .filter((cue) => cue.kind === "speed")
    .toSorted((a, b) => a.start - b.start);
  const boundaries = [
    ...new Set([0, duration, ...speeds.flatMap((cue) => [cue.start, cue.end])]),
  ].toSorted((a, b) => a - b);
  let cursor = 0;
  const segments = boundaries.slice(1).map((end) => {
    const start = cursor;
    cursor = end;
    return {
      start,
      end,
      factor: speeds.find((cue) => cue.start <= start && cue.end > start)?.factor ?? 1,
    };
  });
  const remap = (time: number) =>
    segments.reduce(
      (sum, segment) =>
        sum + Math.max(0, Math.min(time, segment.end) - segment.start) / segment.factor,
      0,
    );
  const n = (value: number) => String(Number(value.toFixed(9)));
  const filters = segments.map(
    (segment, index) =>
      `[0:v]trim=start=${n(segment.start)}:end=${n(segment.end)},setpts=(PTS-STARTPTS)/${n(segment.factor)}[part${index}]`,
  );
  filters.push(
    `${segments.map((_, index) => `[part${index}]`).join("")}concat=n=${segments.length}:v=1:a=0,fps=${n(fps)}[timed]`,
  );
  const { width, height } = cues.viewport;
  const t = `(in/${n(fps)})`;
  const upscale = cues.scale === 1 ? 2 : 1;
  let z = "1";
  let x = "iw/2";
  let y = "ih/2";
  for (const cue of cues.cues.filter((entry) => entry.kind === "zoom").toReversed()) {
    const start = remap(cue.start);
    const end = remap(cue.end);
    const ease = Math.min(cue.ease, (cue.end - cue.start) / 2);
    const rampIn = remap(cue.start + ease);
    const rampOut = remap(cue.end - ease);
    const envelope =
      ease === 0
        ? "1"
        : `if(lt(${t},${n(rampIn)}),(1-cos(PI*(${t}-${n(start)})/${n(rampIn - start)}))/2,if(lt(${t},${n(rampOut)}),1,(1-cos(PI*(${n(end)}-${t})/${n(end - rampOut)}))/2))`;
    const active = `gte(${t},${n(start)})*lt(${t},${n(end)})`;
    z = `if(${active},1+${n(cue.factor - 1)}*(${envelope}),${z})`;
    x = `if(${active},${n((cue.rect.x + cue.rect.width / 2) * cues.scale * upscale)},${x})`;
    y = `if(${active},${n((cue.rect.y + cue.rect.height / 2) * cues.scale * upscale)},${y})`;
  }
  const source = upscale === 1 ? "" : `scale=${width * 2}:${height * 2}:flags=lanczos,`;
  filters.push(
    `[timed]${source}zoompan=z='${z}':x='clip((${x})-iw/zoom/2,0,iw-iw/zoom)':y='clip((${y})-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${width}x${height}:fps=${n(fps)}[zoomed]`,
  );
  const inputs: string[] = [];
  let outputMap = "[zoomed]";
  for (const cue of cues.cues.filter((entry) => entry.kind === "caption")) {
    inputs.push(cue.image);
    const output = `[caption${inputs.length}]`;
    filters.push(
      `${outputMap}[${inputs.length}:v]overlay=x=0:y=${height - cues.captionHeight}:enable='gte(t,${n(remap(cue.start))})*lt(t,${n(remap(cue.end))})'${output}`,
    );
    outputMap = output;
  }
  return { inputs, filterComplex: filters.join(";"), outputMap, durationSeconds: remap(duration) };
}
