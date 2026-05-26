//#region extensions/mattermost/src/mattermost/monitor-auth.d.ts
declare function isMattermostSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}): boolean;
//#endregion
export { isMattermostSenderAllowed as t };