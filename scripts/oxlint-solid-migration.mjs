const marker = /\bTODO\(solid2\)/u;

export default {
  meta: { name: "openclaw-solid-migration" },
  rules: {
    "no-pending-conversion": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          pending: "Resolve this Solid migration marker before landing: {{reason}}",
        },
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (marker.test(comment.value)) {
                context.report({
                  loc: comment.loc,
                  messageId: "pending",
                  data: { reason: comment.value.trim() },
                });
              }
            }
          },
        };
      },
    },
  },
};
