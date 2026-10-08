import { createHash } from "node:crypto";
import { canonicalizeJsonValue } from "./canonical-json.mjs";

export function releaseChildReuseSha256(selection) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJsonValue(selection)))
    .digest("hex");
}

// Dispatch reuse runs before dependency installation. Accept only the scalar
// input declarations used by these workflows; unfamiliar YAML means fresh work.
export function releaseChildDispatchInputs(source, args) {
  const block = source.match(
    /^ {2}workflow_dispatch:\n {4}inputs:\n((?:[ \t].*\n|\n)*?)(?=^ {2}\S|^\S|$(?![\s\S]))/mu,
  )?.[1];
  if (!block) {
    throw new Error("Cannot read workflow dispatch inputs");
  }
  const inputs = {};
  let key;
  let type;
  let defaultValue;
  const finish = () => {
    if (!key) {
      return;
    }
    if (!["boolean", "choice", "number", "string"].includes(type)) {
      throw new Error("Unsupported workflow dispatch input type");
    }
    inputs[key] = defaultValue ?? (type === "boolean" ? "false" : type === "number" ? "0" : "");
  };
  for (const line of block.split("\n")) {
    const declaration = /^ {6}([a-z][a-z0-9_]*):$/u.exec(line);
    if (declaration) {
      finish();
      key = declaration[1];
      if (Object.hasOwn(inputs, key)) {
        throw new Error("Duplicate workflow dispatch input");
      }
      type = undefined;
      defaultValue = undefined;
    } else if (line.startsWith("        type: ")) {
      type = line.slice(14);
    } else if (line.startsWith("        default: ")) {
      const value = line.slice(17);
      if (/^"(?:[^"\\]|\\.)*"$/u.test(value)) {
        defaultValue = JSON.parse(value);
      } else if (/^[a-zA-Z0-9@._/-]+$/u.test(value)) {
        defaultValue = value;
      } else {
        throw new Error("Unsupported workflow dispatch default");
      }
    } else if (line.trim() && !/^ {8}(?:description:|required:|options:| {2}- )/u.test(line)) {
      throw new Error("Unsupported workflow dispatch declaration");
    }
  }
  finish();
  const supplied = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const entry = args[index + 1];
    const separator = entry?.indexOf("=") ?? -1;
    const name = entry?.slice(0, separator);
    if (
      args[index] !== "-f" ||
      separator < 1 ||
      !Object.hasOwn(inputs, name) ||
      supplied.has(name)
    ) {
      throw new Error("Unsupported workflow dispatch argument");
    }
    supplied.add(name);
    inputs[name] = entry.slice(separator + 1);
  }
  delete inputs.dispatch_id;
  return inputs;
}
