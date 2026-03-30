import { describe } from "vitest";
import { installSlackInboundContractSuite } from "../../../test/helpers/channels/inbound-contract.js";

describe("slack inbound contract", () => {
	installSlackInboundContractSuite();
});
