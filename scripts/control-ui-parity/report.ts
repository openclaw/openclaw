import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { z } from "zod";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { KNOWN_NONDETERMINISTIC_SHOTS } from "./config.ts";

// Repeated pinned Chromium captures can round antialiased shadows by one level.
// Larger differences remain failures; accepted noise is always counted separately.
export const MAX_RASTER_NOISE_CHANNEL_DELTA = 1;

export type Shot = {
  id: string;
  scene: string;
  profile: string;
  label: string;
  file: string;
  sha256: string;
  width: number;
  height: number;
};
export type Capture = {
  version: 1;
  source: { head: string; dirty: string[] };
  browser: string;
  platform: string;
  catalog: string;
  contract: { expectedShots: string[]; fixtures: string };
  options: { scene?: string; profile?: string; css?: string };
  shots: Shot[];
  failures: Array<{ id: string; error: string }>;
  complete: boolean;
};
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const safeId = /^[a-z0-9][a-z0-9-]*$/u;
const knownNondeterministicNote = (id: string) => {
  const reason = KNOWN_NONDETERMINISTIC_SHOTS.get(id);
  return reason ? `<p>Known nondeterministic: ${escape(reason)}</p>` : "";
};
const captureSchema = z.object({
  version: z.literal(1),
  source: z.object({ head: z.string().min(1), dirty: z.array(z.string()) }),
  browser: z.string().min(1),
  platform: z.string().min(1),
  catalog: z.string().regex(/^[a-f0-9]{64}$/u),
  contract: z.object({
    expectedShots: z.array(z.string().regex(safeId)).min(1),
    fixtures: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  options: z.object({
    scene: z.string().optional(),
    profile: z.string().optional(),
    css: z.string().optional(),
  }),
  shots: z
    .array(
      z.object({
        id: z.string().regex(safeId),
        scene: z.string().min(1),
        profile: z.string().min(1),
        label: z.string().min(1),
        file: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .min(1),
  failures: z.array(z.object({ id: z.string(), error: z.string() })),
  complete: z.literal(true),
});

async function loadCapture(directory: string): Promise<Capture> {
  const value = captureSchema.parse(
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
  );
  if (value.failures.length || value.catalog !== hash(JSON.stringify(value.contract))) {
    throw new Error(`Incomplete or unsupported capture: ${directory}`);
  }
  const ids = new Set<string>();
  for (const shot of value.shots) {
    if (!safeId.test(shot.id) || shot.file !== `${shot.id}.png` || ids.has(shot.id)) {
      throw new Error(`Invalid or duplicate shot: ${shot.id}`);
    }
    ids.add(shot.id);
  }
  const expected = new Set(value.contract.expectedShots);
  if (
    expected.size !== value.contract.expectedShots.length ||
    expected.size !== ids.size ||
    [...expected].some((id) => !ids.has(id))
  ) {
    throw new Error(`Capture does not contain its exact expected shot set: ${directory}`);
  }
  return value;
}

export async function writeGallery(directory: string, capture: Capture) {
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(capture, null, 2) + "\n");
  const cards = capture.shots
    .map(
      (shot) =>
        `<article id="${shot.id}"><h2>${escape(shot.id)}</h2><p>${escape(shot.label)}</p>${knownNondeterministicNote(shot.id)}<a href="${shot.file}"><img loading="lazy" src="${shot.file}" alt="${escape(shot.label)}"></a><label>Feedback <textarea data-id="${shot.id}" data-label="${escape(shot.label)}"></textarea></label></article>`,
    )
    .join("\n");
  await writeFile(
    path.join(directory, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Control UI parity</title><style>body{font:16px system-ui;margin:2rem;background:#eee;color:#222}article{background:white;padding:1rem;margin:1rem 0}img{max-width:100%;max-height:700px;object-fit:contain}textarea{display:block;width:95%;height:5rem}button{padding:.7rem}h2{overflow-wrap:anywhere}</style><h1>Control UI parity</h1><p>Synthetic mock Gateway. Source ${escape(capture.source.head)}. ${capture.complete ? "Complete" : "Incomplete"} capture, ${capture.shots.length} shots.</p><button id="copy">Copy feedback</button><p id="copy-result" role="status"></p>${cards}<script>
const key = 'openclaw-parity-feedback-' + ${JSON.stringify(capture.catalog)};
let saved = {}; try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
for (const input of document.querySelectorAll('textarea')) {
  input.value = saved[input.dataset.id] || '';
  input.addEventListener('input', () => { saved[input.dataset.id] = input.value; localStorage.setItem(key, JSON.stringify(saved)); });
}
document.querySelector('#copy').onclick = async () => {
  const text = [...document.querySelectorAll('textarea')].filter(el => el.value.trim()).map(el => '## ' + el.dataset.id + '\\n' + el.dataset.label + '\\n' + el.value).join('\\n\\n');
  try { await navigator.clipboard.writeText(text); document.querySelector('#copy-result').textContent = 'Copied'; }
  catch { document.querySelector('#copy-result').textContent = 'Clipboard unavailable. Select and copy the feedback below.'; const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); }
};
</script></html>`,
  );
}

export async function compareCaptures(beforeDir: string, afterDir: string, parent?: string) {
  const before = await loadCapture(beforeDir);
  const after = await loadCapture(afterDir);
  const directory = createControlUiE2eArtifactDir("parity-diff", parent);
  const incompatible = (["browser", "platform", "catalog"] as const).filter(
    (key) => before[key] !== after[key],
  );
  const beforeShots = new Map(before.shots.map((shot) => [shot.id, shot]));
  const afterShots = new Map(after.shots.map((shot) => [shot.id, shot]));
  const results = [];
  for (const id of [...new Set([...beforeShots.keys(), ...afterShots.keys()])].toSorted()) {
    const left = beforeShots.get(id);
    const right = afterShots.get(id);
    const row = {
      id,
      status: "equal",
      changedPixels: 0,
      rasterNoisePixels: 0,
      totalPixels: 0,
      diff: "",
      knownNondeterministicReason: KNOWN_NONDETERMINISTIC_SHOTS.get(id) ?? null,
    };
    if (!left || !right) {
      row.status = left ? "missing-after" : "missing-before";
    } else {
      const leftBytes = await readFile(path.join(beforeDir, left.file));
      const rightBytes = await readFile(path.join(afterDir, right.file));
      if (hash(leftBytes) !== left.sha256 || hash(rightBytes) !== right.sha256) {
        throw new Error(`Capture changed on disk: ${id}`);
      }
      const a = photon.PhotonImage.new_from_byteslice(leftBytes);
      const b = photon.PhotonImage.new_from_byteslice(rightBytes);
      try {
        const width = a.get_width();
        const height = a.get_height();
        if (
          width !== left.width ||
          height !== left.height ||
          b.get_width() !== right.width ||
          b.get_height() !== right.height
        ) {
          throw new Error(`PNG dimensions disagree with the manifest: ${id}`);
        }
        row.totalPixels = width * height;
        if (width !== b.get_width() || height !== b.get_height()) {
          row.status = "dimensions";
        } else {
          const pixels = a.get_raw_pixels();
          const other = b.get_raw_pixels();
          const diff = new Uint8Array(pixels.length);
          for (let i = 0; i < pixels.length; i += 4) {
            let maximumDelta = 0;
            for (let channel = 0; channel < 4; channel += 1) {
              maximumDelta = Math.max(
                maximumDelta,
                Math.abs(pixels[i + channel]! - other[i + channel]!),
              );
            }
            const changed = maximumDelta > MAX_RASTER_NOISE_CHANNEL_DELTA;
            const noise = maximumDelta > 0 && !changed;
            if (changed) {
              row.changedPixels += 1;
            } else if (noise) {
              row.rasterNoisePixels += 1;
            }
            diff.set(
              changed
                ? [255, 0, 80, 255]
                : noise
                  ? [0, 128, 255, 255]
                  : [pixels[i]!, pixels[i]!, pixels[i]!, 70],
              i,
            );
          }
          if (row.changedPixels || row.rasterNoisePixels) {
            if (row.changedPixels) {
              row.status = row.knownNondeterministicReason ? "known-nondeterministic" : "pixels";
            }
            row.diff = `${id}.png`;
            const rendered = new photon.PhotonImage(diff, width, height);
            try {
              await writeFile(path.join(directory, row.diff), rendered.get_bytes());
            } finally {
              rendered.free();
            }
          }
        }
      } finally {
        a.free();
        b.free();
      }
    }
    results.push(row);
  }
  const changed = results.filter(
    (row) => row.status !== "equal" && row.status !== "known-nondeterministic",
  ).length;
  const knownNondeterministic = results.filter(
    (row) => row.status === "known-nondeterministic",
  ).length;
  const rasterNoisePixels = results.reduce((total, row) => total + row.rasterNoisePixels, 0);
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify(
      {
        before: path.resolve(beforeDir),
        after: path.resolve(afterDir),
        incompatible,
        maxRasterNoiseChannelDelta: MAX_RASTER_NOISE_CHANNEL_DELTA,
        changed,
        knownNondeterministic,
        rasterNoisePixels,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  const href = (base: string, shot: Shot | undefined) =>
    shot
      ? escape(
          path
            .relative(directory, path.resolve(base, shot.file))
            .split(path.sep)
            .map(encodeURIComponent)
            .join("/"),
        )
      : "";
  await writeFile(
    path.join(directory, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Control UI parity diff</title><style>body{font:16px system-ui;margin:2rem}img{max-width:32%;vertical-align:top}article{border-top:1px solid #aaa;margin:1rem 0;padding:1rem 0}h2{overflow-wrap:anywhere}</style><h1>${changed} / ${results.length} failing shot differences</h1><p>Known nondeterministic differences: ${knownNondeterministic} shots</p><p>raster noise (≤${MAX_RASTER_NOISE_CHANNEL_DELTA} level): ${rasterNoisePixels} px</p><p>Incompatible metadata: ${escape(incompatible.join(", ") || "none")}</p>${results.map((row) => `<article><h2>${row.id}: ${row.status}</h2>${knownNondeterministicNote(row.id)}<p>${row.changedPixels} / ${row.totalPixels} changed pixels; raster noise (≤${MAX_RASTER_NOISE_CHANNEL_DELTA} level): ${row.rasterNoisePixels} px</p><img alt="Before" src="${href(beforeDir, beforeShots.get(row.id))}"><img alt="After" src="${href(afterDir, afterShots.get(row.id))}">${row.diff ? `<img alt="Difference" src="${row.diff}">` : ""}</article>`).join("\n")}</html>`,
  );
  console.log(
    `[control-ui-parity] ${changed}/${results.length} failing shot differences; known nondeterministic: ${knownNondeterministic} shots; raster noise (≤${MAX_RASTER_NOISE_CHANNEL_DELTA} level): ${rasterNoisePixels} px; report: ${directory}`,
  );
  return changed || incompatible.length ? 1 : 0;
}
