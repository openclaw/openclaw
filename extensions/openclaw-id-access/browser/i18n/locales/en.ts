const en = {
  role: "Role",
  administrator: "Administrator access",
  noAdministrator: "No administrator access",
  invitedAccess: "Only sessions they’re invited to · Can be invited up to {level}",
  invitedPermission: "Participant permission: {mode}",
  permissions: {
    "read-only": "Read only",
    guarded: "Guarded",
    workspace: "Workspace",
    full: "Full",
  },
  invitationLevels: {
    read: "Read",
    suggest: "Suggest",
    send: "Send",
  },
  sessions: {
    invited: "Only sessions they’re invited to",
    none: "No access to other people's sessions",
    view: "Read other people's sessions",
    suggest: "Read and suggest changes to other people's sessions",
    write: "Read and change other people's sessions",
  },
  sandboxRequired: "Sandbox required",
  ownSandboxRequired: "Sandbox required for their own sessions",
  sandboxInherited: "Sandbox follows agent settings",
  sandboxNotReady: "Sandbox required · not set up yet",
  sandboxNeeded: "The {role} role needs a sandbox.",
  sandboxEngineUnavailable: "{engine} isn't running on the computer that hosts this claw.",
  sandboxImageMissing: "Its sandbox isn't installed on this claw yet.",
  sandboxAskBody: "OpenClaw can set this up for you.",
  sandboxAsk: "Ask OpenClaw to set it up",
  sandboxAsked:
    "OpenClaw is working on this in the chat beside this page. When it's done, check again to invite people with this role.",
  sandboxAskFailed: "Couldn't start a chat with OpenClaw. Try again.",
  sandboxCheckAgain: "Check again",
  noRoles:
    "No roles are defined on this claw. Add a role in gateway.roles.definitions before inviting someone.",
  invalidRoleName:
    "Unavailable for members: use 1–64 lowercase letters, digits, - or _, starting with a letter. Rename this role in config.",
  noUsableRoles:
    "No roles have a valid member role name. Use 1–64 lowercase letters, digits, - or _, starting with a letter, in gateway.roles.definitions.",
  adminConfirm:
    "The {role} role has administrator access. Administrators can change Gateway settings, manage devices and approvals, and access connected services. Only invite someone you trust with this claw.",
  adminInvite: "Confirm administrator invite",
  cancel: "Cancel",
  blocked: "Blocked",
  undefinedRole:
    "The role {role} is not defined on this claw. An administrator can assign another role in Settings → Team → Roles to restore access.",
  yourRole: "Your role: {role}",
};

export default en;
