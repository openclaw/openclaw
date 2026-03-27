import { describeSessionBindingContractCoverage } from "../../../test/helpers/channels/session-binding-contract.js";
import { feishuSessionBindingAdapterChannels } from "../api.js";

describeSessionBindingContractCoverage(feishuSessionBindingAdapterChannels);
