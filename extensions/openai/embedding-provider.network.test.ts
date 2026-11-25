import { testEmbeddingNetworkPolicy } from "../test-support/embedding-network.test-support.js";
import { createOpenAiEmbeddingProvider } from "./embedding-provider.js";

testEmbeddingNetworkPolicy({ id: "openai", create: createOpenAiEmbeddingProvider });
