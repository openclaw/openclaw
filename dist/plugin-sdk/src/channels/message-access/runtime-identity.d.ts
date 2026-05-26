import type { ChannelIngressAdapter, ChannelIngressIdentityDescriptor, ChannelIngressIdentitySubjectInput, ChannelIngressSubject, StableChannelIngressIdentityParams } from "./runtime-types.js";
/** Build an identity descriptor for channels with one stable id and optional aliases. */
export declare function defineStableChannelIngressIdentity(params?: StableChannelIngressIdentityParams): ChannelIngressIdentityDescriptor;
export declare function createIdentityAdapter(identity: ChannelIngressIdentityDescriptor): ChannelIngressAdapter;
export declare function createIdentitySubject(identity: ChannelIngressIdentityDescriptor, input: ChannelIngressIdentitySubjectInput): ChannelIngressSubject;
