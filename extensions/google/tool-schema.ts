import { projectRuntimeToolInputSchema } from "openclaw/plugin-sdk/agent-harness-runtime";

type GoogleToolDeclaration = {
  name: string;
  description?: string;
  parametersJsonSchema?: Record<string, unknown>;
  behavior?: "NON_BLOCKING";
};

type GoogleToolDescriptor = {
  name: string;
  description?: string;
  parameters: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readToolField(
  tool: object,
  field: "name" | "description" | "parameters",
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(tool, field) };
  } catch {
    return { ok: false };
  }
}

function readToolEntry(
  tools: readonly GoogleToolDescriptor[],
  toolIndex: number,
): { ok: true; tool: unknown } | { ok: false } {
  try {
    return { ok: true, tool: Reflect.get(tools, String(toolIndex)) };
  } catch {
    return { ok: false };
  }
}

export function buildGoogleFunctionDeclarations(
  tools: readonly GoogleToolDescriptor[] | undefined,
  options: { nonBlockingToolName?: string } = {},
): GoogleToolDeclaration[] {
  let length: number;
  try {
    length = tools?.length ?? 0;
  } catch {
    return [];
  }

  const declarations: GoogleToolDeclaration[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    const entry = readToolEntry(tools ?? [], toolIndex);
    if (!entry.ok || !isRecord(entry.tool)) {
      continue;
    }

    const name = readToolField(entry.tool, "name");
    if (!name.ok || typeof name.value !== "string" || !name.value) {
      continue;
    }

    const parameters = readToolField(entry.tool, "parameters");
    if (!parameters.ok) {
      continue;
    }

    const description = readToolField(entry.tool, "description");
    const declaration: GoogleToolDeclaration = {
      name: name.value,
    };
    if (parameters.value !== undefined) {
      const projection = projectRuntimeToolInputSchema(
        parameters.value,
        `${name.value}.parameters`,
      );
      if (projection.violations.length > 0 || !isRecord(projection.schema)) {
        continue;
      }
      declaration.parametersJsonSchema = projection.schema;
    }
    if (description.ok && typeof description.value === "string") {
      declaration.description = description.value;
    }
    if (name.value === options.nonBlockingToolName) {
      declaration.behavior = "NON_BLOCKING";
    }
    declarations.push(declaration);
  }
  return declarations;
}
