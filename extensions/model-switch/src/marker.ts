import fs from "node:fs";
import path from "node:path";
import type { SwitchMarker } from "./types.js";

const MARKER_FILENAME = "model-switch-pending.json";

export function getMarkerPath(stateDir: string): string {
  return path.join(stateDir, MARKER_FILENAME);
}

export function writeMarker(stateDir: string, marker: SwitchMarker): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(getMarkerPath(stateDir), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

export function readMarker(stateDir: string): SwitchMarker | null {
  const markerPath = getMarkerPath(stateDir);
  if (!fs.existsSync(markerPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8")) as SwitchMarker;
  } catch {
    return null;
  }
}

export function deleteMarker(stateDir: string): void {
  fs.rmSync(getMarkerPath(stateDir), { force: true });
}

export function isMarkerStale(marker: SwitchMarker, maxAgeMs: number): boolean {
  const requestedAtMs = Date.parse(marker.requestedAt);
  if (!Number.isFinite(requestedAtMs)) {
    return true;
  }
  return Date.now() - requestedAtMs > maxAgeMs;
}

export function incrementMarkerAttempt(stateDir: string, marker: SwitchMarker): void {
  marker.attemptCount += 1;
  writeMarker(stateDir, marker);
}
