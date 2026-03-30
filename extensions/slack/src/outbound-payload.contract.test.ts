import { describe } from "vitest";
import { installSlackOutboundPayloadContractSuite } from "../../../test/helpers/channels/outbound-payload-contract.js";

describe("slack outbound payload contract", () => {
	installSlackOutboundPayloadContractSuite();
});
