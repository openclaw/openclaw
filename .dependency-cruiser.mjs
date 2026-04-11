/** @type {import("dependency-cruiser").IConfiguration} */
const config = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular runtime imports pull entire strongly connected components into the graph and make lazy boundaries harder to preserve.",
      from: {
        path: "^(src|extensions|scripts)",
      },
      to: {
        circular: true,
        dependencyTypesNot: ["type-only"],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "(^|/)node_modules(/|$)",
    },
    exclude: {
      path: ["(^|/)(coverage|dist|docs|vendor)(/|$)", "\\.(test|spec)\\.(ts|tsx|js|jsx|mjs|cjs)$"],
    },
    includeOnly: "^(src|extensions|scripts)",
    tsConfig: {
      fileName: "tsconfig.json",
    },
  },
};

export default config;
