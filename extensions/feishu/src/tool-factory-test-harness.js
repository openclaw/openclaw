function toToolList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
function asToolLike(tool, fallbackName) {
  const candidate = tool;
  const name = candidate.name ?? fallbackName;
  const execute = candidate.execute;
  if (!name || typeof execute !== "function") {
    throw new Error(`Resolved tool is missing required fields (name=${String(name)})`);
  }
  return {
    name,
    execute: (toolCallId, params) => execute(toolCallId, params)
  };
}
function createToolFactoryHarness(cfg) {
  const registered = [];
  const api = {
    config: cfg,
    logger: {
      info: () => {
      },
      warn: () => {
      },
      error: () => {
      },
      debug: () => {
      }
    },
    registerTool: (tool, opts) => {
      registered.push({ tool, opts });
    }
  };
  const resolveTool = (name, ctx = {}) => {
    for (const entry of registered) {
      if (entry.opts?.name === name && typeof entry.tool !== "function") {
        return asToolLike(entry.tool, name);
      }
      if (typeof entry.tool === "function") {
        const builtTools = toToolList(entry.tool(ctx));
        const hit = builtTools.find((tool) => tool.name === name);
        if (hit) {
          return asToolLike(hit, name);
        }
      } else if (entry.tool.name === name) {
        return asToolLike(entry.tool, name);
      }
    }
    throw new Error(`Tool not registered: ${name}`);
  };
  return {
    api,
    resolveTool
  };
}
export {
  createToolFactoryHarness
};
