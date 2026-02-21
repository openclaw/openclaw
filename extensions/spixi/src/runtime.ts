import axios from "axios";
import type { PluginRuntime } from "openclaw/plugin-sdk";

type SpixiChannelRuntime = {
  sendMessage: (to: string, text: string, opts?: { baseUrl?: string }) => Promise<unknown>;
  addContact: (address: string, opts?: { baseUrl?: string }) => Promise<unknown>;
  getFriendList: (opts?: { baseUrl?: string }) => Promise<string[]>;
  acceptContact: (address: string, opts?: { baseUrl?: string }) => Promise<unknown>;
};

export type SpixiRuntime = {
  channel: {
    spixi: SpixiChannelRuntime;
  };
};

// Default QuIXI API URL - can be overridden via config.
let defaultBaseUrl = "http://localhost:8001";

const spixiRuntime: SpixiRuntime = {
  channel: {
    spixi: {
      sendMessage: async (to, text, opts) => {
        const baseUrl = opts?.baseUrl || defaultBaseUrl;
        try {
          const url = new URL("/sendChatMessage", baseUrl);
          url.searchParams.set("address", to);
          url.searchParams.set("message", text);
          url.searchParams.set("channel", "0");
          const res = await axios.get(url.toString());
          return {
            messageId: `spixi-${Date.now()}`,
            ...res.data,
          };
        } catch (e: unknown) {
          if (e instanceof Error) {
            throw new Error(`Spixi send failed: ${e.message}`, { cause: e });
          }
          throw new Error("Spixi send failed: Unknown error", { cause: e });
        }
      },
      addContact: async (address, opts) => {
        const baseUrl = opts?.baseUrl || defaultBaseUrl;
        try {
          const url = new URL("/addContact", baseUrl);
          url.searchParams.set("address", address);
          const res = await axios.get(url.toString());
          return {
            success: true,
            address,
            ...res.data,
          };
        } catch (e: unknown) {
          if (e instanceof Error) {
            throw new Error(`Spixi addContact failed: ${e.message}`, { cause: e });
          }
          throw new Error("Spixi addContact failed: Unknown error", { cause: e });
        }
      },
      getFriendList: async (opts) => {
        const baseUrl = opts?.baseUrl || defaultBaseUrl;
        try {
          const url = new URL("/contacts", baseUrl);
          const res = await axios.get(url.toString());
          const contacts = res.data || [];
          return Array.isArray(contacts)
            ? (contacts
                .map((c: { address?: string } | string) =>
                  typeof c === "object" && c !== null && "address" in c
                    ? (c as { address?: string }).address
                    : c,
                )
                .filter(Boolean) as string[])
            : [];
        } catch (e: unknown) {
          if (e instanceof Error) {
            throw new Error(`Spixi getFriendList failed: ${e.message}`, { cause: e });
          }
          throw new Error("Spixi getFriendList failed: Unknown error", { cause: e });
        }
      },
      acceptContact: async (address, opts) => {
        const baseUrl = opts?.baseUrl || defaultBaseUrl;
        try {
          const url = new URL("/acceptContact", baseUrl);
          url.searchParams.set("address", address);
          const res = await axios.get(url.toString());
          return {
            success: true,
            address,
            ...res.data,
          };
        } catch (e: unknown) {
          if (e instanceof Error) {
            throw new Error(`Spixi acceptContact failed: ${e.message}`, { cause: e });
          }
          throw new Error("Spixi acceptContact failed: Unknown error", { cause: e });
        }
      },
    },
  },
};

export function setSpixiBaseUrl(url: string) {
  defaultBaseUrl = url;
}

export const getSpixiRuntime = (): SpixiRuntime => spixiRuntime;

export const setSpixiRuntime = (_runtime: PluginRuntime) => {};
