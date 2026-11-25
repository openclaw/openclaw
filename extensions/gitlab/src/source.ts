import {
  createManagedProjectCheckoutV1,
  type RepositorySourceV1,
} from "openclaw/plugin-sdk/repository-sources";
import { createGitLabTransport } from "./transport.js";
import { parseGitLabProjectUrl } from "./url.js";

/** Public GitLab projects through host-managed local checkouts. */
export function createGitLabRepositorySource(origin: string): RepositorySourceV1 {
  const admit = (url: string) => parseGitLabProjectUrl(url, origin);
  const checkout = createManagedProjectCheckoutV1(
    createGitLabTransport((url) => {
      const admitted = admit(url);
      return admitted ? { url: admitted.url, name: admitted.name } : null;
    }),
  );
  return {
    id: "repositories",
    resolve(url) {
      const admitted = admit(url);
      return admitted
        ? {
            url: admitted.url,
            name: admitted.name,
            display: { identity: admitted.fullName, host: new URL(origin).host },
          }
        : undefined;
    },
    async prepare({ url, requiredCommit, signal, assertCurrent }) {
      const project = await checkout.materialize(
        { gitUrl: url, ...(requiredCommit ? { requiredCommit } : {}) },
        { signal, assertCurrent },
      );
      return {
        project,
        assertCurrent,
        resolveBase: (ref) => checkout.resolveBase(project, ref, { signal, assertCurrent }),
      };
    },
  };
}
