import { describe } from "vitest";
import { installDiscordOutboundPayloadContractSuite } from "../../../test/helpers/channels/outbound-payload-contract.js";

describe("discord outbound payload contract", () => {
	installDiscordOutboundPayloadContractSuite();
});
