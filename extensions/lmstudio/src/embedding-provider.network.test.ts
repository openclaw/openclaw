import { testEmbeddingNetworkPolicy } from "../../test-support/embedding-network.test-support.js";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

testEmbeddingNetworkPolicy({ id: "lmstudio", create: createLmstudioEmbeddingProvider });
