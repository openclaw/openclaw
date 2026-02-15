/**
 * State Store — Local filesystem implementation for testing/dev.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PlaneState, StateStore } from "../types.js";

export class LocalStateStore implements StateStore {
  constructor(private directory: string) {}

  private filePath(planeId: string): string {
    return path.join(this.directory, `${planeId}.json`);
  }

  private lockPath(planeId: string): string {
    return path.join(this.directory, `${planeId}.lock`);
  }

  async load(planeId: string): Promise<PlaneState | null> {
    try {
      const data = await fs.readFile(this.filePath(planeId), "utf-8");
      return JSON.parse(data) as PlaneState;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async save(state: PlaneState): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    state.version = (state.version || 0) + 1;
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(this.filePath(state.config.name), JSON.stringify(state, null, 2));
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.directory);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async lock(planeId: string): Promise<() => Promise<void>> {
    await fs.mkdir(this.directory, { recursive: true });
    const lockFile = this.lockPath(planeId);
    const lockData = JSON.stringify({
      holder: process.pid,
      acquired: Date.now(),
      expires: Date.now() + 60_000,
    });

    // Simple advisory lock — check if existing lock is expired
    try {
      const existing = JSON.parse(await fs.readFile(lockFile, "utf-8"));
      if (existing.expires > Date.now()) {
        throw new Error(`Plane '${planeId}' is locked by pid ${existing.holder}`);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT" && !err.message?.includes("is locked")) {
        throw err;
      }
      if (err.message?.includes("is locked")) {
        throw err;
      }
    }

    await fs.writeFile(lockFile, lockData);
    return async () => {
      try {
        await fs.unlink(lockFile);
      } catch {
        // Already unlocked
      }
    };
  }
}
