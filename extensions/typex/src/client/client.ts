import { fetchWithSsrFGuard, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { TypeXMessageEnum, type TypeXClientOptions } from "./types.js";

const TYPEX_DOMAIN = "https://api-coco.typex.im";
const TYPEX_ALLOWED_HOSTNAMES = ["api-coco.typex.im"] as const;

let prompter: WizardPrompter | undefined;

export class TypeXClient {
  private options: TypeXClientOptions;
  private accessToken?: string;
  private userId?: string;

  constructor(options: TypeXClientOptions) {
    this.options = options;
    if (options.token) {
      this.accessToken = options.token;
    }
  }

  async getAccessToken() {
    if (this.accessToken) {
      return this.accessToken;
    }
    return "";
  }

  async getCurUserId() {
    if (this.userId) {
      return this.userId;
    }
    return "";
  }

  async fetchQrcodeUrl() {
    try {
      const { response: qrResponse, release } = await fetchWithSsrFGuard({
        url: `${TYPEX_DOMAIN}/user/qrcode?login_type=open`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        policy: { allowedHostnames: [...TYPEX_ALLOWED_HOSTNAMES] },
        auditContext: "typex.fetchQrcodeUrl",
      });

      try {
        if (!qrResponse.ok) {
          throw new Error(`Failed to get QR code: ${qrResponse.statusText}`);
        }
        const qrResult = await qrResponse.json();
        if (qrResult.code !== 0 || !qrResult.data) {
          throw new Error(`Failed to get QR code: ${qrResult.msg}`);
        }

        return qrResult.data;
      } finally {
        await release();
      }
    } catch (error) {
      throw error;
    }
  }

  async checkLoginStatus(qrcodeId: string) {
    try {
      const { response: checkRes, release } = await fetchWithSsrFGuard({
        url: `${TYPEX_DOMAIN}/open/qrcode/check_auth`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            qr_code_id: qrcodeId,
          }),
        },
        policy: { allowedHostnames: [...TYPEX_ALLOWED_HOSTNAMES] },
        auditContext: "typex.checkLoginStatus",
      });

      try {
        const setCookieHeader = checkRes.headers.get("set-cookie");

        if (setCookieHeader) {
          const match = setCookieHeader.match(/(sessionid=[^;]+)/);

          if (match && match[1]) {
            this.accessToken = match[1];
          }
        }
        const checkData = await checkRes.json();
        if (checkData.code === 0) {
          const { user_id } = checkData.data;
          this.userId = user_id;
          return true;
        } else if (checkData.code === 10001) {
          return false;
        } else {
          return false;
        }
      } finally {
        await release();
      }
    } catch (error) {
      throw error;
    }
  }

  async sendMessage(to: string, content: string | object, msgType: TypeXMessageEnum = 0) {
    const token = this.accessToken;
    if (!token) {
      throw new Error("TypeXClient: Not authenticated.");
    }

    let finalContent = content;
    if (typeof content === "object") {
      try {
        finalContent = JSON.stringify(content);
      } catch (e) {
        if (e instanceof Error) {
          if (prompter) prompter.note("Failed to stringify message content");
          else console.log("Failed to stringify message content");
        }
        finalContent = String(content as unknown);
      }
    }

    if (prompter)
      prompter.note(
        `TypeXClient sending message: to=${to} content=${typeof finalContent === "string" ? finalContent : JSON.stringify(finalContent)}`,
      );
    else
      console.log(
        `TypeXClient sending message: to=${to} content=${typeof finalContent === "string" ? finalContent : JSON.stringify(finalContent)}`,
      );

    try {
      const url = `${TYPEX_DOMAIN}/open/claw/send_message`;
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: token,
          },
          body: JSON.stringify({
            ...(to ? { chat_id: to } : {}),
            content: {
              text: finalContent,
            },
            msg_type: msgType,
          }),
        },
        policy: { allowedHostnames: [...TYPEX_ALLOWED_HOSTNAMES] },
        auditContext: "typex.sendMessage",
      });

      try {
        const resJson = await response.json();

        if (resJson.code !== 0) {
          throw new Error(`Send message failed: [${resJson.code}] ${resJson.message}`);
        }

        if (prompter) prompter.note("Message sent successfully", resJson.data);
        else console.log("Message sent successfully", JSON.stringify(resJson.data));

        return (
          resJson.data || {
            message_id: `msg_${Date.now()}`,
          }
        );
      } finally {
        await release();
      }
    } catch (error) {
      if (prompter) prompter.note(`Error sending message to TypeX API: ${error}`);
      else console.log(`Error sending message to TypeX API: ${error}`);
      throw error;
    }
  }

  async fetchMessages(pos: number) {
    if (!this.accessToken) {
      if (prompter) prompter.note("TypeXClient: No token, skipping fetch.");
      else console.log("TypeXClient: No token, skipping fetch.");
      return [];
    }

    try {
      const url = `${TYPEX_DOMAIN}/open/claw/message`;
      if (prompter) prompter.note(`Fetching messages from pos: ${pos}`);
      // else console.log(`Fetching messages from pos: ${pos}`);
      const { response, release } = await fetchWithSsrFGuard({
        url,
        init: {
          method: "POST",
          headers: {
            Cookie: this.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ pos: pos }),
        },
        policy: { allowedHostnames: [...TYPEX_ALLOWED_HOSTNAMES] },
        auditContext: "typex.fetchMessages",
      });

      try {
        const resJson = await response.json();

        if (resJson.code !== 0) {
          if (prompter) prompter.note(`Fetch failed with code ${resJson.code}: ${resJson.message}`);
          else console.log(`Fetch failed with code ${resJson.code}: ${resJson.message}`);
          return [];
        }
        if (Array.isArray(resJson.data)) {
          return resJson.data;
        }

        return [];
      } finally {
        await release();
      }
    } catch (e) {
      if (prompter) prompter.note(`Fetch messages network error: ${e}`);
      else console.log(`Fetch messages network error: ${e}`);
      return [];
    }
  }
}

export function getTypeXClient(accountId?: string, manualOptions?: TypeXClientOptions) {
  const typexCfg = (manualOptions?.typexCfg ?? {}) as Record<string, any>;
  const clawPrompter = manualOptions?.prompter;
  if (clawPrompter) {
    prompter = clawPrompter;
  }

  let token = manualOptions?.token;

  if (accountId && typexCfg.accounts?.[accountId]) {
    token = typexCfg.accounts[accountId].token;
  }

  if (!manualOptions?.skipConfigCheck) {
    throw new Error("TypeX not configured yet.");
  }

  return new TypeXClient({
    token: token,
  });
}
