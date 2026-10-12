import { vi } from "vitest";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

const { prepareSessionGenerationFacts: prepareCanonicalSessionGenerationFacts } =
  await vi.importActual<typeof import("../../../config/sessions/session-delivery-generation.js")>(
    "../../../config/sessions/session-delivery-generation.js",
  );
const { withSessionEntryReadOnlyInWorker: readCanonicalSessionEntry } = await vi.importActual<
  typeof import("../../../config/sessions/session-entry-read-runtime.js")
>("../../../config/sessions/session-entry-read-runtime.js");
const { captureSessionEntryCurrentRead: captureCanonicalSessionEntryCurrent } =
  await vi.importActual<typeof import("../../../config/sessions/session-entry-current-runtime.js")>(
    "../../../config/sessions/session-entry-current-runtime.js",
  );

export function resetSubagentRegistrySessionMocks(
  mocks: ReturnType<typeof createSubagentRegistryMockState>,
) {
  vi.mocked(prepareSessionGenerationFacts)
    .mockReset()
    .mockImplementation((input) =>
      input.storePath === mocks.resolveStorePath()
        ? mocks.prepareSessionGenerationFacts(input)
        : prepareCanonicalSessionGenerationFacts(input),
    );
  vi.mocked(withSessionEntryReadOnlyInWorker)
    .mockReset()
    .mockImplementation((...args) =>
      args[0].storePath === mocks.resolveStorePath()
        ? mocks.withSessionEntryReadOnlyInWorker(...args)
        : readCanonicalSessionEntry(...args),
    );
  vi.mocked(readSessionEntryReadOnlyInWorker)
    .mockReset()
    .mockImplementation((scope, assertCurrent = () => {}) =>
      withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        return read.value;
      }),
    );
  vi.mocked(captureSessionEntryCurrentRead)
    .mockReset()
    .mockImplementation((scope, owner) =>
      scope.storePath === mocks.resolveStorePath()
        ? mocks.captureSessionEntryCurrentRead(scope, owner)
        : captureCanonicalSessionEntryCurrent(scope, owner),
    );
}
