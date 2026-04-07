export async function importNodeLlamaCpp(): Promise<typeof import("node-llama-cpp")> {
  return import("node-llama-cpp");
}
