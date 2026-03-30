import { describe } from "vitest";
import { installTelegramInboundContractSuite } from "../../../test/helpers/channels/inbound-contract.js";

describe("telegram inbound contract", () => {
	installTelegramInboundContractSuite();
});
