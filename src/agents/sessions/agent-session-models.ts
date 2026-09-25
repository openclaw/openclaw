import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "@openclaw/ai/internal/runtime";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withSessionMetadataPublication,
  withSessionTranscriptWriteAssertion,
  type SessionMetadataCommit,
} from "../../config/sessions/transcript-write-context.js";
import type { Model } from "../../llm/types.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { AgentSessionPrompting } from "./agent-session-prompting.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { ThinkingLevelSelectEvent } from "./extensions/types.js";
import { SessionMetadataCommittedError } from "./session-manager-metadata-error.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

type ThinkingSelection = { event: ThinkingLevelSelectEvent; saveDefault: boolean };

export abstract class AgentSessionModels extends AgentSessionPrompting {
  // =========================================================================
  // Model Management
  // =========================================================================

  private async emitModelSelect(
    nextModel: Model,
    previousModel: Model | undefined,
    runner: ExtensionRunner,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent() || modelsAreEqual(previousModel, nextModel)) {
      return;
    }
    await runner.emit({
      type: "model_select",
      model: nextModel,
      previousModel,
      source: "set",
    });
  }

  /** Set the model after validating its current auth at write admission. */
  async setModel(model: Model): Promise<void> {
    const owner = this.captureMetadataOwner();
    const {
      previousModel,
      thinkingSelection: committedThinkingSelection,
      commit: committedMetadata,
    } = await owner.run(() =>
      withSessionManagerWrite(owner.manager, async () => {
        owner.assertCurrent();
        if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
          throw new Error(`No API key for ${model.provider}/${model.id}`);
        }
        // Queued transitions replace the state at admission, not at invocation.
        const previous = this.model;
        const thinkingSelection = this.planThinkingLevel(
          this.getThinkingLevelForModelSwitch(),
          model,
        );
        const publication: { commit?: SessionMetadataCommit } = {};
        await withSessionMetadataPublication(
          owner.manager,
          { type: "model_change", provider: model.provider, modelId: model.id },
          (commit) => {
            publication.commit = commit;
            this.agent.state.model = model;
            this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
          },
          () => owner.manager.appendModelChange(model.provider, model.id),
        );
        if (thinkingSelection) {
          try {
            owner.assertCurrent();
            publication.commit =
              (await this.appendThinkingSelection(owner, thinkingSelection)) ?? publication.commit;
          } catch (cause) {
            this.failAfterMetadataCommit(cause, publication.commit);
          }
        }
        return {
          previousModel: previous,
          thinkingSelection: thinkingSelection?.event,
          commit: publication.commit,
        };
      }),
    );
    // Hooks can await another transition after this write has settled.
    try {
      const thinking = this.emitThinkingLevelSelect(
        committedThinkingSelection,
        owner.runner,
        owner.isCurrent,
      );
      const selected = this.emitModelSelect(model, previousModel, owner.runner, owner.isCurrent);
      const notifications = await Promise.allSettled([thinking, selected]);
      const failures = notifications.flatMap((result): unknown[] =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Session metadata notifications failed", {
          cause: failures[0],
        });
      }
    } catch (cause) {
      this.failAfterMetadataCommit(cause, committedMetadata);
    }
  }

  // =========================================================================
  // Thinking Level Management
  // =========================================================================

  /**
   * Set thinking level.
   * Clamps to model capabilities based on available thinking levels.
   * Saves to session and settings only if the level actually changes.
   */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const owner = this.captureMetadataOwner();
    const committedSelection = await owner.run(() =>
      withSessionManagerWrite(owner.manager, async () => {
        owner.assertCurrent();
        const selection = this.planThinkingLevel(level, this.model);
        if (!selection) {
          return undefined;
        }
        const commit = await this.appendThinkingSelection(owner, selection);
        return { event: selection.event, commit };
      }),
    );
    try {
      await this.emitThinkingLevelSelect(committedSelection?.event, owner.runner, owner.isCurrent);
    } catch (cause) {
      this.failAfterMetadataCommit(cause, committedSelection?.commit);
    }
  }

  private planThinkingLevel(
    level: ThinkingLevel,
    model: Model | undefined,
  ): ThinkingSelection | undefined {
    const availableLevels = model ? getSupportedThinkingLevels(model) : THINKING_LEVELS;
    const effectiveLevel = availableLevels.includes(level)
      ? level
      : model
        ? (clampThinkingLevel(model, level) as ThinkingLevel)
        : "off";
    const previousLevel = this.agent.state.thinkingLevel;
    if (effectiveLevel === previousLevel) {
      return undefined;
    }
    return {
      event: { type: "thinking_level_select", level: effectiveLevel, previousLevel },
      saveDefault: Boolean(model?.reasoning) || effectiveLevel !== "off",
    };
  }

  private async appendThinkingSelection(
    owner: ReturnType<AgentSessionModels["captureMetadataOwner"]>,
    selection: ThinkingSelection,
  ): Promise<SessionMetadataCommit | undefined> {
    const publication: { commit?: SessionMetadataCommit } = {};
    await withSessionMetadataPublication(
      owner.manager,
      { type: "thinking_level_change", thinkingLevel: selection.event.level },
      (commit) => {
        publication.commit = commit;
        this.agent.state.thinkingLevel = selection.event.level;
        if (selection.saveDefault) {
          this.settingsManager.setDefaultThinkingLevel(selection.event.level);
        }
      },
      () => owner.manager.appendThinkingLevelChange(selection.event.level),
    );
    return publication.commit;
  }

  private emitThinkingLevelSelect(
    event: ThinkingLevelSelectEvent | undefined,
    runner: ExtensionRunner,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (event && isCurrent()) {
      this.emit({ type: "thinking_level_changed", level: event.level });
      if (isCurrent()) {
        return runner.emit(event);
      }
    }
    return Promise.resolve();
  }

  private failAfterMetadataCommit(
    cause: unknown,
    commit: SessionMetadataCommit | undefined,
  ): never {
    if (cause instanceof SessionMetadataCommittedError || !commit) {
      throw cause;
    }
    throw new SessionMetadataCommittedError(commit.entry, commit.version, cause, commit.target);
  }

  private captureMetadataOwner() {
    const manager = this.sessionManager;
    const target = manager.getSessionTarget();
    const sessionId = manager.getSessionId();
    const runner = this.currentExtensionRunner;
    const assertAmbient = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
    const isBound = () => {
      const current = manager.getSessionTarget();
      return (
        manager.getSessionId() === sessionId && sameSessionTranscriptTargetBinding(target, current)
      );
    };
    const assertCurrent = () => {
      if (!isBound()) {
        throw new Error("Session manager identity changed before transcript write admission");
      }
      if (
        this.currentExtensionRunner !== runner ||
        runner.createContext().sessionManager !== manager
      ) {
        throw new Error("Session metadata source changed before publication");
      }
      assertAmbient?.();
    };
    return {
      manager,
      runner,
      assertCurrent,
      isCurrent: () => {
        try {
          assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
      run: <T>(operation: () => Promise<T>): Promise<T> =>
        target
          ? withSessionTranscriptWriteAssertion(target, assertCurrent, operation)
          : operation(),
    };
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
