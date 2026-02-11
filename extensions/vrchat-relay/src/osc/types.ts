export interface OSCConfig {
  outgoingPort: number;
  incomingPort: number;
  host: string;
}

export interface OSCMessage {
  address: string;
  args: (string | number | boolean | Uint8Array | null)[];
}

export interface OSCBundle {
  timetag: number;
  elements: (OSCMessage | OSCBundle)[];
}

export type OSCPacket = OSCMessage | OSCBundle;

export interface AvatarParameter {
  name: string;
  type: "bool" | "int" | "float";
  value: boolean | number;
}

export interface VRChatOSCPaths {
  chatbox: string;
  chatboxTyping: string;
  avatarChange: string;
  voice: string;
}

export const DEFAULT_OSC_PATHS: VRChatOSCPaths = {
  chatbox: "/chatbox/input",
  chatboxTyping: "/chatbox/typing",
  avatarChange: "/avatar/change",
  voice: "/voice",
};

export const DEFAULT_OSC_CONFIG: OSCConfig = {
  outgoingPort: 9000,
  incomingPort: 9001,
  host: "127.0.0.1",
};
