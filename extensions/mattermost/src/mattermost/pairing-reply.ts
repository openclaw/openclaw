type MattermostPairingReplyInput = {
  channel: "mattermost";
  idLine: string;
  code: string;
};

export function resolveMattermostPairingReply(params: {
  code: string | undefined;
  userId: string;
  buildReply: (input: MattermostPairingReplyInput) => string;
}): string | undefined {
  const code = params.code?.trim();
  if (!code) {
    return undefined;
  }
  return params.buildReply({
    channel: "mattermost",
    idLine: `Your Mattermost user id: ${params.userId}`,
    code,
  });
}
