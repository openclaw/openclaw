import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "@openclaw/ai/internal/runtime";
import type { Model } from "../../llm/types.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { AgentSessionPrompting } from "./agent-session-prompting.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ThinkingLevelSelectEvent } from "./extensions/types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

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

  /** Set the model after validating its current auth at write admission. */
  async setModel(model: Model): Promise<void> {
    const { previousModel, thinkingSelection } = await withSessionManagerWrite(
      this.sessionManager,
      () => {
        if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
          throw new Error(`No API key for ${model.provider}/${model.id}`);
        }
        // Queued transitions replace the state at admission, not at invocation.
        const previous = this.model;
        const thinkingLevel = this.getThinkingLevelForModelSwitch();
        this.sessionManager.appendModelChange(model.provider, model.id);
        this.agent.state.model = model;
        this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
        return {
          previousModel: previous,
          thinkingSelection: this.updateThinkingLevel(thinkingLevel),
        };
      },
    );
    // Hooks can await another transition after this write has settled.
    this.emitThinkingLevelSelect(thinkingSelection);
    await this.emitModelSelect(model, previousModel);
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
    this.emitThinkingLevelSelect(this.updateThinkingLevel(level));
  }

  private updateThinkingLevel(level: ThinkingLevel): ThinkingLevelSelectEvent | undefined {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level);

    // Only persist if actually changing
    const previousLevel = this.agent.state.thinkingLevel;
    if (effectiveLevel === previousLevel) {
      return undefined;
    }
    this.sessionManager.appendThinkingLevelChange(effectiveLevel);
    this.agent.state.thinkingLevel = effectiveLevel;
    if (this.supportsThinking() || effectiveLevel !== "off") {
      this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
    }
    return { type: "thinking_level_select", level: effectiveLevel, previousLevel };
  }

  private emitThinkingLevelSelect(event: ThinkingLevelSelectEvent | undefined): void {
    if (event) {
      this.emit({ type: "thinking_level_changed", level: event.level });
      void this.currentExtensionRunner.emit(event);
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
