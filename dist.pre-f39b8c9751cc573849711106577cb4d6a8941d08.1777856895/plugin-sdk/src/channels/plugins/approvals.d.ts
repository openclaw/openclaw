import type { ChannelApprovalAdapter, ChannelApprovalCapability } from "./types.adapters.js";
import type { ChannelPlugin } from "./types.plugin.js";
export declare function resolveChannelApprovalCapability(plugin?: Pick<ChannelPlugin, "approvalCapability"> | null): ChannelApprovalCapability | undefined;
export declare function resolveChannelApprovalAdapter(plugin?: Pick<ChannelPlugin, "approvalCapability"> | null): ChannelApprovalAdapter | undefined;
