// Records the before_prompt_build event a plugin receives on a real Gateway turn,
// so the embedded runtime's prompt-boundary contract can be asserted end to end.
const captures = { beforePromptBuild: [] };

export default {
  id: "qa-prompt-build-current-input-probe",
  register(api) {
    api.on("before_prompt_build", (event, ctx) => {
      captures.beforePromptBuild.push({
        keys: Object.keys(event).sort(),
        hasCurrentUserMessage: Object.prototype.hasOwnProperty.call(event, "currentUserMessage"),
        currentUserMessage: event.currentUserMessage ?? null,
        hasCurrentUserMessageId: Object.prototype.hasOwnProperty.call(
          event,
          "currentUserMessageId",
        ),
        currentUserMessageId: event.currentUserMessageId ?? null,
        prompt: typeof event.prompt === "string" ? event.prompt : null,
        trigger: ctx?.trigger ?? null,
      });
    });
    api.registerHttpRoute({
      path: "/qa/prompt-build-current-input",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(_req, res) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(`${JSON.stringify(captures)}\n`);
        return true;
      },
    });
  },
};
