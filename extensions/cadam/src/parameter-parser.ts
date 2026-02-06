/**
 * Parameter parser for OpenSCAD code
 * Adapted from CADAM: https://github.com/Adam-CAD/CADAM
 */

export interface Parameter {
  name: string;
  displayName: string;
  type: "number" | "boolean" | "string" | "number[]" | "string[]" | "boolean[]";
  value: string | number | boolean | number[] | string[] | boolean[];
  defaultValue: string | number | boolean | number[] | string[] | boolean[];
  description?: string;
  group?: string;
  range?: {
    min?: number;
    max?: number;
    step?: number;
  };
  options?: Array<{
    value: string | number;
    label?: string;
  }>;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function convertType(rawValue: string): {
  value: string | boolean | number | string[] | number[] | boolean[];
  type: Parameter["type"];
} {
  if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
    return { value: Number.parseFloat(rawValue), type: "number" };
  }
  if (rawValue === "true" || rawValue === "false") {
    return { value: rawValue === "true", type: "boolean" };
  }
  if (/^".*"$/.test(rawValue)) {
    rawValue = rawValue.replace(/^"(.*)"$/, "$1");
    return { value: rawValue, type: "string" };
  }
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const arrayValue = rawValue
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim());

    if (arrayValue.length > 0 && arrayValue.every((item) => /^\d+(\.\d+)?$/.test(item))) {
      return {
        value: arrayValue.map((item) => Number.parseFloat(item)),
        type: "number[]",
      };
    }
    if (arrayValue.length > 0 && arrayValue.every((item) => /^".*"$/.test(item))) {
      return {
        value: arrayValue.map((item) => item.slice(1, -1)),
        type: "string[]",
      };
    }
    if (arrayValue.length > 0 && arrayValue.every((item) => item === "true" || item === "false")) {
      return {
        value: arrayValue.map((item) => item === "true"),
        type: "boolean[]",
      };
    }
    throw new Error(
      `Invalid array value: ${rawValue}. Array elements must be all numbers, all booleans, or all quoted strings and not empty.`,
    );
  }

  throw new Error(`Invalid value: ${rawValue}`);
}

export function parseParameters(script: string): Parameter[] {
  // Limit the script to the upper part of the file
  script = script.split(/^(module |function )/m)[0];

  const parameters: Record<string, Parameter> = {};
  const parameterRegex = /^([a-z0-9A-Z_$]+)\s*=\s*([^;]+);[\t\f\cK ]*(\/\/[^\n]*)?/gm;
  const groupRegex = /^\/\*\s*\[([^\]]+)\]\s*\*\//gm;

  const groupSections: { id: string; group: string; code: string }[] = [
    {
      id: "",
      group: "",
      code: script,
    },
  ];
  let tmpGroup;

  // Find groups
  while ((tmpGroup = groupRegex.exec(script))) {
    groupSections.push({
      id: tmpGroup[0],
      group: tmpGroup[1].trim(),
      code: "",
    });
  }

  // Add code to groupSections
  for (let index = 0; index < groupSections.length; index++) {
    const group = groupSections[index];
    const nextGroup = groupSections[index + 1];
    const startIndex = script.indexOf(group.id);
    const endIndex = nextGroup ? script.indexOf(nextGroup.id) : script.length;
    group.code = script.substring(startIndex, endIndex);
  }

  // If we have more than one group, adjust the first group
  if (groupSections.length > 1) {
    groupSections[0].code = script.substring(0, script.indexOf(groupSections[1].id));
  }

  for (const groupSection of groupSections) {
    let match;
    while ((match = parameterRegex.exec(groupSection.code)) !== null) {
      const name = match[1];
      const value = match[2];
      let typeAndValue: { value: Parameter["value"]; type: Parameter["type"] } | undefined;
      try {
        typeAndValue = convertType(value);
      } catch {
        continue;
      }

      if (!typeAndValue) {
        continue;
      }

      let description: Parameter["description"];
      const options: Parameter["options"] = [];
      let range: Parameter["range"] = {};

      // Check if the value is another variable or an expression
      if (
        value !== "true" &&
        value !== "false" &&
        (value.match(/^[a-zA-Z_]/) || value.split("\n").length > 1)
      ) {
        continue;
      }

      if (match[3]) {
        const rawComment = match[3].replace(/^\/\/\s*/, "").trim();
        const cleaned = rawComment.replace(/^\[+|\]+$/g, "");

        if (!Number.isNaN(Number(rawComment))) {
          if (typeAndValue.type === "string") {
            range = { max: Number.parseFloat(cleaned) };
          } else {
            range = { step: Number.parseFloat(cleaned) };
          }
        } else if (rawComment.startsWith("[") && cleaned.includes(",")) {
          options.push(
            ...cleaned
              .trim()
              .split(",")
              .map((option) => {
                const parts = option.trim().split(":");
                let value: string | number = parts[0];
                const label: string | undefined = parts[1];
                if (typeAndValue.type === "number") {
                  value = Number.parseFloat(value);
                }
                return { value, label };
              }),
          );
        } else if (cleaned.match(/([0-9]+:?)+/)) {
          const [min, maxOrStep, max] = cleaned.trim().split(":");

          if (min && (maxOrStep || max)) {
            range = { min: Number.parseFloat(min) };
          }
          if (max || maxOrStep || min) {
            range = { ...range, max: Number.parseFloat(max || maxOrStep || min) };
          }
          if (max && maxOrStep) {
            range = { ...range, step: Number.parseFloat(maxOrStep) };
          }
        }
      }

      // Search for the comment right above the parameter definition
      let above = script.split(new RegExp(`^${escapeRegExp(match[0])}`, "gm"))[0];

      if (above.endsWith("\n")) {
        above = above.slice(0, -1);
      }

      const splitted = above.split("\n").toReversed();
      const lastLineBeforeDefinition = splitted[0];
      if (lastLineBeforeDefinition.trim().startsWith("//")) {
        description = lastLineBeforeDefinition.replace(/^\/\/\/*\s*/, "");
        if (description.length === 0) {
          description = undefined;
        }
      }

      let displayName = name
        .replace(/_/g, " ")
        .split(" ")
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(" ");
      if (name === "$fn") {
        displayName = "Resolution";
      }

      parameters[name] = {
        description,
        group: groupSection.group,
        name,
        displayName,
        defaultValue: typeAndValue.value,
        range,
        options,
        ...typeAndValue,
      };
    }
  }

  return Object.values(parameters);
}

export function applyParameterChanges(
  code: string,
  updates: Array<{ name: string; value: string | number | boolean }>,
): string {
  let patchedCode = code;
  const currentParams = parseParameters(code);

  for (const upd of updates) {
    const target = currentParams.find((p) => p.name === upd.name);
    if (!target) {
      continue;
    }

    let coerced: string | number | boolean = upd.value;
    try {
      if (target.type === "number") {
        coerced = Number(upd.value);
      } else if (target.type === "boolean") {
        coerced = String(upd.value) === "true";
      } else if (target.type === "string") {
        coerced = String(upd.value);
      } else {
        coerced = upd.value;
      }
    } catch {
      coerced = upd.value;
    }

    patchedCode = patchedCode.replace(
      new RegExp(
        `^\\s*(${escapeRegExp(target.name)}\\s*=\\s*)[^;]+;([\\t\\f\\cK ]*\\/\\/[^\\n]*)?`,
        "m",
      ),
      (_match, g1: string, g2: string) => {
        if (target.type === "string") {
          return `${g1}"${String(coerced).replace(/"/g, '\\"')}";${g2 || ""}`;
        }
        return `${g1}${coerced};${g2 || ""}`;
      },
    );
  }

  return patchedCode;
}
