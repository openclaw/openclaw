/**
 * Adaptive Tone — an OpenClaw plugin.
 *
 * Registers a single `before_prompt_build` hook that inspects context (time of
 * day, channel, repeated asks, user-stated wellbeing, and local weather) and
 * returns `appendSystemContext` to steer the assistant's tone for that turn. It
 * changes delivery only — never facts, capability, or safety behaviour — and it
 * touches no OpenClaw core code.
 *
 * Hook reference (verified against OpenClaw source):
 *   firing site : src/agents/pi-embedded-runner/run/attempt.ts (before_prompt_build)
 *   contract    : src/plugins/hook-before-agent-start.types.ts
 *   api.on      : src/plugins/types.ts (OpenClawPluginApi.on)
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig } from "./src/config.js";
import { HEADER, FOOTER, toneGuidance, weatherGuidance } from "./src/guidance.js";
import { resolveToneState } from "./src/states.js";
import { fetchWeatherCondition } from "./src/weather.js";

export default definePluginEntry({
  id: "adaptive-tone",
  name: "Adaptive Tone",
  description:
    "Adjusts the assistant's tone by context — time of day, channel, repeated questions, " +
    "user-stated wellbeing, and local weather. Steers delivery only, not facts or safety.",
  register(api: OpenClawPluginApi) {
    const config = normalizeConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.debug?.("adaptive-tone: disabled via config; not registering hook.");
      return;
    }

    // `event` and `ctx` are typed automatically via the `before_prompt_build`
    // generic on api.on — no manual type imports needed.
    api.on("before_prompt_build", async (event, ctx) => {
      try {
        const state = resolveToneState(
          {
            prompt: event.prompt,
            messages: event.messages,
            channelId: ctx.channelId,
          },
          new Date(),
          config,
        );

        let guidance = toneGuidance(state, config);
        let weatherText: string | undefined = undefined;

        if (config.weather.enabled) {
          const condition = await fetchWeatherCondition(
            config.weather.latitude,
            config.weather.longitude,
          );
          weatherText = weatherGuidance(condition);
        }

        // Merge weather guidance into the tone guidance fragment. Weather is
        // additive — it layers on top of whatever tone state was resolved.
        if (weatherText) {
          if (guidance) {
            // Strip the existing footer, append the weather line, re-add footer.
            const baseGuidance = guidance.replace(`\n${FOOTER}`, "");
            guidance = `${baseGuidance}\n- ${weatherText}\n${FOOTER}`;
          } else {
            guidance = `${HEADER}\n- ${weatherText}\n${FOOTER}`;
          }
        }

        if (!guidance) return undefined;

        // appendSystemContext is cached by providers; see guidance.ts for the
        // cache-stability contract.
        api.logger.debug?.(`adaptive-tone: state=${state} (+${guidance.length} chars)`);
        return { appendSystemContext: guidance };
      } catch (error) {
        // Fail open: a tone tweak must never block or break a reply.
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(`adaptive-tone: skipped (${message})`);
        return undefined;
      }
    });

    api.logger.debug?.("adaptive-tone: registered before_prompt_build hook.");
  },
});
