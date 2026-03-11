import { describe, expect, it } from "vitest";
import {
  extractPythonImportUsages,
  renderSandboxPythonExecutionTemplate,
  validateSandboxPythonExecution,
} from "./execution-policy.js";
import type { SandboxExecutionConfig } from "./types.js";

const baseExecution: SandboxExecutionConfig = {
  template: "python-research-v1",
  imports: {
    allow: ["json", "math", "pathlib"],
    deny: ["os", "subprocess"],
  },
  dependencies: {
    allow: ["numpy", "pandas"],
    deny: ["requests"],
  },
};

describe("sandbox execution policy", () => {
  it("extracts normalized Python imports", () => {
    expect(
      extractPythonImportUsages(`
        import math
        import pandas as pd, numpy.linalg as la
        from pathlib import Path
      `),
    ).toEqual([
      expect.objectContaining({ line: 1, root: "math", category: "import" }),
      expect.objectContaining({ line: 2, root: "pandas", category: "dependency" }),
      expect.objectContaining({ line: 2, root: "numpy", category: "dependency" }),
      expect.objectContaining({ line: 3, root: "pathlib", category: "import" }),
    ]);
  });

  it("renders a deterministic Python template envelope", () => {
    const first = renderSandboxPythonExecutionTemplate({
      code: "\r\nimport math\nprint(math.sqrt(4))\n",
      objective: "  compare   returns \n safely ",
      requiredTools: ["write", "read", "write"],
    });
    const second = renderSandboxPythonExecutionTemplate({
      code: "import math\nprint(math.sqrt(4))\n",
      objective: "compare returns safely",
      requiredTools: ["read", "write"],
    });
    expect(first).toBe(second);
    expect(first).toContain("# OpenClaw sandbox template: python-research-v1");
    expect(first).toContain("# Required tools: read, write");
  });

  it("accepts allowlisted imports, dependencies, and tools", () => {
    const result = validateSandboxPythonExecution({
      code: `
        import math
        import pandas as pd
        from pathlib import Path

        print(math.sqrt(9))
        print(Path("data.csv"))
      `,
      objective: "summarize a CSV-backed experiment",
      requiredTools: ["read", "exec"],
      execution: baseExecution,
      tools: { allow: ["exec", "read"], deny: ["browser"] },
    });

    expect(result.imports).toHaveLength(3);
    expect(result.rendered).toContain("# Objective: summarize a CSV-backed experiment");
  });

  it("blocks denied stdlib imports", () => {
    expect(() =>
      validateSandboxPythonExecution({
        code: "import os\nprint('x')\n",
        requiredTools: ["exec"],
        execution: baseExecution,
        tools: { allow: ["exec"], deny: [] },
      }),
    ).toThrow(/import "os" is blocked by sandbox\.execution\.imports\.deny/);
  });

  it("blocks non-allowlisted dependencies", () => {
    expect(() =>
      validateSandboxPythonExecution({
        code: "import requests\n",
        requiredTools: ["exec"],
        execution: baseExecution,
        tools: { allow: ["exec"], deny: [] },
      }),
    ).toThrow(/dependency "requests" is blocked by sandbox\.execution\.dependencies\.deny/);

    expect(() =>
      validateSandboxPythonExecution({
        code: "import scipy\n",
        requiredTools: ["exec"],
        execution: baseExecution,
        tools: { allow: ["exec"], deny: [] },
      }),
    ).toThrow(/dependency "scipy" is not allowlisted by sandbox\.execution\.dependencies\.allow/);
  });

  it("blocks relative imports and disallowed tools", () => {
    expect(() =>
      validateSandboxPythonExecution({
        code: "from .local import helper\n",
        requiredTools: ["browser"],
        execution: baseExecution,
        tools: { allow: ["exec", "read"], deny: ["browser"] },
      }),
    ).toThrow(/relative import "\.local" is not allowed/);

    expect(() =>
      validateSandboxPythonExecution({
        code: "import math\n",
        requiredTools: ["browser"],
        execution: baseExecution,
        tools: { allow: ["exec", "read"], deny: ["browser"] },
      }),
    ).toThrow(/tool "browser" is blocked by sandbox tool deny policy/);
  });

  it("rejects template mismatches", () => {
    expect(() =>
      validateSandboxPythonExecution({
        code: "import math\n",
        requiredTools: ["exec"],
        template: "python-research-v1-other" as "python-research-v1",
        execution: baseExecution,
        tools: { allow: ["exec"], deny: [] },
      }),
    ).toThrow(/template "python-research-v1-other" is not allowed/);
  });
});
