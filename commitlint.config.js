export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // New feature
        "fix", // Bug fix
        "docs", // Documentation
        "style", // Code style (formatting, etc)
        "refactor", // Code refactoring
        "perf", // Performance improvement
        "test", // Add/update tests
        "build", // Build system changes
        "ci", // CI configuration
        "chore", // Other changes
        "revert", // Revert commit
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "timing",
        "hooks",
        "types",
        "easings",
        "transitions",
        "scripts",
        "docs",
        "ci",
        "deps",
        "examples",
      ],
    ],
    "subject-case": [0],
  },
};
