import { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { TypeXMessageEnum, type TypeXClientOptions } from "./types.js";

const TYPEX_DOMAIN = "https://api-coco.typex.im";

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
      const qrResponse = await fetch(`${TYPEX_DOMAIN}/user/qrcode?login_type=open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!qrResponse.ok) {
        throw new Error(`Failed to get QR code: ${qrResponse.statusText}`);
      }
      const qrResult = await qrResponse.json();
      if (qrResult.code !== 0 || !qrResult.data) {
        throw new Error(`Failed to get QR code: ${qrResult.msg}`);
      }

      return qrResult.data;
    } catch (error) {
      throw error;
    }
  }

  async checkLoginStatus(qrcodeId: string) {
    try {
      const checkRes = await fetch(`${TYPEX_DOMAIN}/open/qrcode/check_auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          qr_code_id: qrcodeId,
        }),
      });
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
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: token,
        },
        body: JSON.stringify({
          content: {
            text: finalContent,
          },
          msg_type: msgType,
        }),
      });
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
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Cookie: this.accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pos: pos }),
      });

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
