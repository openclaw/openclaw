/** 通知通道目标（与 OpenClaw outbound 适配器对接）。 */
export type NotifyChannelTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type ClaworksNotifyConfig = {
  targets?: NotifyChannelTarget[];
  /** Playbook notify 步骤仅给 channel 名时的默认通道 */
  default_channel?: string;
};
