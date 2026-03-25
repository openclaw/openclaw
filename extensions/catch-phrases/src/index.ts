import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MatchMode = "startsWith" | "exact" | "contains";

interface CatchPhrase {
  trigger: string;
  response: string;
  matchMode?: MatchMode;
}

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

function matchPhrase(text: string, phrase: CatchPhrase): boolean {
  const normalized = text.trim().toLowerCase();
  const trigger = phrase.trigger.trim().toLowerCase();
  const mode: MatchMode = phrase.matchMode ?? "startsWith";

  switch (mode) {
    case "exact":
      return normalized === trigger;
    case "contains":
      return normalized.includes(trigger);
    case "startsWith":
    default:
      return normalized.startsWith(trigger);
  }
}

function findMatch(text: string, phrases: CatchPhrase[]): CatchPhrase | undefined {
  for (const phrase of phrases) {
    if (matchPhrase(text, phrase)) {
      return phrase;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const catchPhrasesPlugin = {
  id: "catch-phrases",
  name: "Catch Phrases",
  description:
    "Configurable catch-phrase auto-responses. When an inbound message " +
    "matches a trigger phrase, the agent responds with the predefined text " +
    "instead of generating a new response. Works across all channels.",

  register(api: OpenClawPluginApi) {
    const rawPhrases = (api.pluginConfig?.phrases as CatchPhrase[] | undefined) ?? [];

    if (rawPhrases.length === 0) {
      api.logger.warn("catch-phrases: no phrases configured — plugin has nothing to do");
      return;
    }

    // Validate phrases
    const phrases: CatchPhrase[] = [];
    for (const p of rawPhrases) {
      if (!p.trigger || !p.response) {
        api.logger.warn(`catch-phrases: skipping invalid entry (missing trigger or response)`);
        continue;
      }
      phrases.push(p);
    }

    api.logger.info(`catch-phrases: loaded ${phrases.length} phrase(s)`);

    // -----------------------------------------------------------------
    // Hook: before_agent_start — intercept and inject catch-phrase
    // response so the agent echoes it verbatim instead of generating.
    //
    // Priority 200 — very high so it runs before all other hooks.
    // The agent still runs but is constrained to output exactly the
    // predefined response via a strong system-level instruction.
    // -----------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (event) => {
        const prompt = event.prompt ?? "";
        if (!prompt) {
          return {};
        }

        const match = findMatch(prompt, phrases);
        if (!match) {
          return {};
        }

        api.logger.info(
          `catch-phrases: matched trigger "${match.trigger.slice(0, 40)}…" → sending predefined response`,
        );

        return {
          prependContext: [
            "[CATCH_PHRASE_MATCH]",
            "The user's message matched a predefined catch phrase.",
            "You MUST respond with EXACTLY the following text — no additions, no commentary, no greetings:",
            "",
            match.response,
            "",
            "Do not paraphrase, summarize, or modify the above text in any way.",
            "[/CATCH_PHRASE_MATCH]",
          ].join("\n"),
        };
      },
      { priority: 200 },
    );
  },
};

export default catchPhrasesPlugin;
