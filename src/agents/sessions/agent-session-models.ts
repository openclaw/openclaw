import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "@openclaw/ai/internal/runtime";
import type { Model } from "../../llm/types.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { AgentSessionPrompting } from "./agent-session-prompting.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export abstract class AgentSessionModels extends AgentSessionPrompting {
  // =========================================================================
  // Model Management
  // =========================================================================

  private async emitModelSelect(nextModel: Model, previousModel: Model | undefined): Promise<void> {
    if (modelsAreEqual(previousModel, nextModel)) {
      return;
    }
    await this.currentExtensionRunner.emit({
      type: "model_select",
      model: nextModel,
      previousModel,
      source: "set",
    });
  }

  private async applyModelSwitch(model: Model, thinkingLevel: ThinkingLevel): Promise<void> {
    const previousModel = this.model;
    this.agent.state.model = model;
    this.sessionManager.appendModelChange(model.provider, model.id);
    this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    this.setThinkingLevel(thinkingLevel);
    await this.emitModelSelect(model, previousModel);
  }

  /**
   * Set model directly.
   * Validates that auth is configured, saves to session and settings.
   * @throws Error if no auth is configured for the model
   */
  async setModel(model: Model): Promise<void> {
    if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }

    const thinkingLevel = this.getThinkingLevelForModelSwitch();
    await this.applyModelSwitch(model, thinkingLevel);
  }

  // =========================================================================
  // Thinking Level Management
  // =========================================================================

  /**
   * Set thinking level.
   * Clamps to model capabilities based on available thinking levels.
   * Saves to session and settings only if the level actually changes.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level);

    // Only persist if actually changing
    const previousLevel = this.agent.state.thinkingLevel;
    const isChanging = effectiveLevel !== previousLevel;

    this.agent.state.thinkingLevel = effectiveLevel;

    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (this.supportsThinking() || effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
      this.emit({ type: "thinking_level_changed", level: effectiveLevel });
      void this.currentExtensionRunner.emit({
        type: "thinking_level_select",
        level: effectiveLevel,
        previousLevel,
      });
    }
  }

  /**
   * Get available thinking levels for current model.
   * The provider will clamp to what the specific model supports internally.
   */
  getAvailableThinkingLevels(): ThinkingLevel[] {
    if (!this.model) {
      return THINKING_LEVELS;
    }
    return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
  }

  /**
   * Check if current model supports thinking/reasoning.
   */
  supportsThinking(): boolean {
    return Boolean(this.model?.reasoning);
  }

  private getThinkingLevelForModelSwitch(): ThinkingLevel {
    if (!this.supportsThinking()) {
      return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    return this.thinkingLevel;
  }

  private clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
    return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
  }

  // =========================================================================
  // Queue Mode Management
  // =========================================================================

  /**
   * Set steering message mode.
   * Saves to settings.
   */
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.agent.steeringMode = mode;
    this.settingsManager.setSteeringMode(mode);
  }

  /**
   * Set follow-up message mode.
   * Saves to settings.
   */
  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.agent.followUpMode = mode;
    this.settingsManager.setFollowUpMode(mode);
  }
}
