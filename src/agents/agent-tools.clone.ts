import type { AnyAgentTool } from "./agent-tools.types.js";

export function cloneToolWithExecute(
  tool: AnyAgentTool,
  execute: AnyAgentTool["execute"],
): AnyAgentTool {
  const descriptorTarget = Object.create(Object.getPrototypeOf(tool)) as AnyAgentTool;
  const descriptors: PropertyDescriptorMap = { ...Object.getOwnPropertyDescriptors(tool) };
  delete descriptors.execute;
  Object.defineProperties(descriptorTarget, descriptors);
  Object.defineProperty(descriptorTarget, "execute", {
    value: execute,
    enumerable: true,
    configurable: true,
    writable: true,
  });

  const localProperties = new Set<PropertyKey>(["execute"]);
  // Keep own descriptors on the wrapper for enumeration and marker writes, but
  // read source properties with the original receiver so class/proxy accessors keep their state.
  return new Proxy(descriptorTarget, {
    defineProperty(target, property, descriptor) {
      localProperties.add(property);
      return Reflect.defineProperty(target, property, descriptor);
    },
    get(target, property, receiver) {
      if (localProperties.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      return Reflect.get(tool, property, tool);
    },
    set(target, property, value, receiver) {
      if (localProperties.has(property)) {
        return Reflect.set(target, property, value, receiver);
      }
      return Reflect.set(tool, property, value, tool);
    },
  });
}
