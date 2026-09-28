/** Portable, declarative Lobster Pack definitions shared by Gateway and Control UI. */
export const LOBSTER_LOCAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LOBSTER_POSES = ["idle", "busy", "sleeping", "happy", "error"] as const;
export type LobsterPose = (typeof LOBSTER_POSES)[number];
export type LobsterAnchor = { x: number; y: number };
export type LobsterAnimation = { frames: number[]; fps: number; loop: boolean };
export type LobsterAppearance =
  | { kind: "svg"; source: string; anchor: LobsterAnchor }
  | {
      kind: "sprite-atlas";
      source: string;
      anchor: LobsterAnchor;
      frameWidth: number;
      frameHeight: number;
      animations: Partial<Record<LobsterPose, LobsterAnimation>> & { idle: LobsterAnimation };
      reducedMotionFrame: number;
    };
export type LobsterDefinition = {
  id: string;
  name: string;
  description?: string;
  appearance: LobsterAppearance;
};
export type LobsterPackDefinition = {
  schemaVersion: 1;
  name: string;
  clawmojis: LobsterDefinition[];
};
type PublishedAppearance<T> = T extends { source: string }
  ? Omit<T, "source"> & { url: string }
  : never;
export type LobsterCatalogEntry = Omit<LobsterDefinition, "appearance"> & {
  source: "plugin";
  pluginId: string;
  packId: string;
  packName: string;
  appearance: PublishedAppearance<LobsterAppearance>;
};
export const MAX_LOBSTER_PACK_BYTES = 64 * 1024;
export const MAX_LOBSTER_ARTWORK_BYTES = 512 * 1024;
export const MAX_LOBSTER_IMAGE_DIMENSION = 4096;
export const MAX_LOBSTER_PACK_CHARACTERS = 32;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  // SAFETY: the guard excludes null and arrays; supported fields are validated by the caller.
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} has unsupported fields`);
  }
}
function printable(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  ) {
    throw new Error(`${label} must contain 1-${max} printable characters`);
  }
  return value.trim();
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}
export function normalizeLobsterPackDefinition(value: unknown): LobsterPackDefinition {
  const root = object(value, "pack");
  keys(root, ["schemaVersion", "name", "clawmojis"], "pack");
  if (root.schemaVersion !== 1) {
    throw new Error("pack.schemaVersion must be 1");
  }
  const name = printable(root.name, 80, "pack.name");
  if (
    !Array.isArray(root.clawmojis) ||
    root.clawmojis.length < 1 ||
    root.clawmojis.length > MAX_LOBSTER_PACK_CHARACTERS
  ) {
    throw new Error(`pack.clawmojis must contain 1-${MAX_LOBSTER_PACK_CHARACTERS} characters`);
  }
  const ids = new Set<string>();
  const clawmojis: LobsterDefinition[] = [];
  for (const raw of root.clawmojis) {
    const entry = object(raw, "clawmoji");
    keys(entry, ["id", "name", "description", "appearance"], "clawmoji");
    if (
      typeof entry.id !== "string" ||
      !LOBSTER_LOCAL_ID_PATTERN.test(entry.id) ||
      ids.has(entry.id)
    ) {
      throw new Error("clawmoji.id must be a unique safe local ID");
    }
    ids.add(entry.id);
    const art = object(entry.appearance, "appearance");
    if (art.kind !== "svg" && art.kind !== "sprite-atlas") {
      throw new Error("appearance.kind must be svg or sprite-atlas");
    }
    keys(
      art,
      art.kind === "svg"
        ? ["kind", "source", "anchor"]
        : [
            "kind",
            "source",
            "anchor",
            "frameWidth",
            "frameHeight",
            "animations",
            "reducedMotionFrame",
          ],
      "appearance",
    );
    const extension = art.kind === "svg" ? "svg" : "png";
    if (
      typeof art.source !== "string" ||
      !new RegExp(`^(?:[a-z0-9_-][a-z0-9._-]*/)*[a-z0-9_-][a-z0-9._-]*\\.${extension}$`, "i").test(
        art.source,
      )
    ) {
      throw new Error(`appearance.source must be a package-relative ${extension} file`);
    }
    const rawAnchor = art.anchor === undefined ? { x: 0.5, y: 1 } : object(art.anchor, "anchor");
    keys(rawAnchor, ["x", "y"], "anchor");
    if (
      typeof rawAnchor.x !== "number" ||
      !Number.isFinite(rawAnchor.x) ||
      rawAnchor.x < 0 ||
      rawAnchor.x > 1 ||
      typeof rawAnchor.y !== "number" ||
      !Number.isFinite(rawAnchor.y) ||
      rawAnchor.y < 0 ||
      rawAnchor.y > 1
    ) {
      throw new Error("anchor.x and anchor.y must be between 0 and 1");
    }
    const anchor = { x: rawAnchor.x, y: rawAnchor.y };
    let appearance: LobsterAppearance;
    if (art.kind === "svg") {
      appearance = { kind: "svg", source: art.source, anchor };
    } else {
      const rawAnimations = object(art.animations, "animations");
      keys(rawAnimations, [...LOBSTER_POSES], "animations");
      const animations: Partial<Record<LobsterPose, LobsterAnimation>> = {};
      for (const pose of LOBSTER_POSES) {
        if (rawAnimations[pose] === undefined) {
          continue;
        }
        const animation = object(rawAnimations[pose], `animations.${pose}`);
        keys(animation, ["frames", "fps", "loop"], `animations.${pose}`);
        if (
          !Array.isArray(animation.frames) ||
          animation.frames.length < 1 ||
          animation.frames.length > 256 ||
          typeof animation.loop !== "boolean"
        ) {
          throw new Error(`animations.${pose} requires 1-256 frames and a boolean loop`);
        }
        animations[pose] = {
          frames: animation.frames.map((frame) => integer(frame, 0, 4095, "frame")),
          fps: integer(animation.fps, 1, 30, "fps"),
          loop: animation.loop,
        };
      }
      if (!animations.idle) {
        throw new Error("animations.idle is required");
      }
      appearance = {
        kind: "sprite-atlas",
        source: art.source,
        anchor,
        frameWidth: integer(art.frameWidth, 1, 1024, "frameWidth"),
        frameHeight: integer(art.frameHeight, 1, 1024, "frameHeight"),
        animations: { ...animations, idle: animations.idle },
        reducedMotionFrame: integer(art.reducedMotionFrame ?? 0, 0, 4095, "reducedMotionFrame"),
      };
    }
    clawmojis.push({
      id: entry.id,
      name: printable(entry.name, 80, "clawmoji.name"),
      ...(entry.description !== undefined
        ? { description: printable(entry.description, 280, "clawmoji.description") }
        : {}),
      appearance,
    });
  }
  return { schemaVersion: 1, name, clawmojis };
}
