import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RouterState } from "./types.js";

const STATE_FILE = path.join(os.homedir(), ".openclaw", "smart-router-state.json");

const DEFAULT_STATE: RouterState = {
  dailyUsage: {},
  lastResetDate: new Date().toISOString().split("T")[0],
};

export class StateManager {
  private state: RouterState = { ...DEFAULT_STATE };

  async load() {
    try {
      const data = await fs.readFile(STATE_FILE, "utf-8");
      this.state = JSON.parse(data);
      this.checkDailyReset();
    } catch (error) {
      // If file doesn't exist, use default
      await this.save();
    }
  }

  async save() {
    await fs.writeFile(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  private checkDailyReset() {
    const today = new Date().toISOString().split("T")[0];
    if (this.state.lastResetDate !== today) {
      this.state.dailyUsage = {};
      this.state.lastResetDate = today;
      this.save(); // Async save but we don't await here to avoid blocking constructor-like usage
    }
  }

  getUsage(profileId: string): number {
    this.checkDailyReset();
    return this.state.dailyUsage[profileId] || 0;
  }

  async incrementUsage(profileId: string) {
    this.checkDailyReset();
    this.state.dailyUsage[profileId] = (this.state.dailyUsage[profileId] || 0) + 1;
    await this.save();
  }

  async resetUsage(profileId?: string) {
    if (profileId) {
      this.state.dailyUsage[profileId] = 0;
    } else {
      this.state.dailyUsage = {};
    }
    await this.save();
  }
}
