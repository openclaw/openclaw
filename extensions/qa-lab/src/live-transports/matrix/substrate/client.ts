import { randomUUID } from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildMatrixQaMediaMessageContent,
  buildMatrixQaMessageContent,
  buildMatrixQaReplacementMessageContent,
  buildMatrixReactionRelation,
  resolveNextRegistrationAuth,
  type MatrixQaUiaaResponse,
} from "./client-message-content.js";
import type { MatrixQaObservedEvent } from "./events.js";
import { readMatrixQaJsonResponse, requestMatrixJson } from "./request.js";
import {
  createMatrixQaRoomObserver,
  primeMatrixQaRoom,
  type MatrixQaRoomObserver,
} from "./sync.js";
import {
  findMatrixQaProvisionedRoom,
  type MatrixQaParticipantRole,
  type MatrixQaProvisionedTopology,
  type MatrixQaTopologySpec,
} from "./topology.js";

export type { MatrixQaRoomObserver } from "./sync.js";

type MatrixQaClientRoomEventWaitParams = Parameters<
  MatrixQaRoomObserver["waitForOptionalRoomEvent"]
>[0] & {
  observedEvents: MatrixQaObservedEvent[];
  since?: string;
};

type MatrixQaRegisterResponse = {
  access_token?: string;
  device_id?: string;
  user_id?: string;
};

type MatrixQaRoomCreateResponse = {
  room_id?: string;
};

type MatrixQaRoomInitialState = Array<{
  content: Record<string, unknown>;
  state_key: string;
  type: string;
}>;

type MatrixQaRegisteredAccount = {
  accessToken: string;
  deviceId?: string;
  localpart: string;
  password: string;
  userId: string;
};

export type MatrixQaProvisionResult = {
  driver: MatrixQaRegisteredAccount;
  observer: MatrixQaRegisteredAccount;
  observationAccounts: Record<"driver" | "observer", MatrixQaRegisteredAccount>;
  roomId: string;
  sut: MatrixQaRegisteredAccount;
  topology: MatrixQaProvisionedTopology;
};

function buildMatrixQaRoomInitialState(encrypted?: boolean): MatrixQaRoomInitialState {
  const initialState: MatrixQaRoomInitialState = [
    {
      type: "m.room.history_visibility",
      state_key: "",
      content: { history_visibility: "joined" },
    },
  ];
  if (encrypted === true) {
    initialState.push({
      type: "m.room.encryption",
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }
  return initialState;
}

function buildRegisteredAccount(params: {
  localpart: string;
  password: string;
  response: MatrixQaRegisterResponse;
}) {
  const userId = params.response.user_id?.trim();
  const accessToken = params.response.access_token?.trim();
  if (!userId || !accessToken) {
    throw new Error("Matrix registration did not return both user_id and access_token.");
  }
  return {
    accessToken,
    deviceId: params.response.device_id?.trim() || undefined,
    localpart: params.localpart,
    password: params.password,
    userId,
  } satisfies MatrixQaRegisteredAccount;
}

function resolveMatrixQaLoginUser(params: { localpart?: string; userId?: string }) {
  const user = params.userId?.trim() || params.localpart?.trim();
  if (!user) {
    throw new Error("Matrix password login requires a localpart or userId.");
  }
  return user;
}

export function createMatrixQaClient(params: {
  accessToken?: string;
  baseUrl: string;
  syncObserver?: MatrixQaRoomObserver;
}) {
  const syncObserver = params.syncObserver;
  const resolveRoomObserver = (opts: MatrixQaClientRoomEventWaitParams) =>
    syncObserver ??
    createMatrixQaRoomObserver({
      accessToken: params.accessToken,
      baseUrl: params.baseUrl,
      observedEvents: opts.observedEvents,
      since: opts.since,
    });
  const request = <T>(options: Omit<Parameters<typeof requestMatrixJson<T>>[0], "baseUrl">) =>
    requestMatrixJson<T>({
      accessToken: params.accessToken,
      ...options,
      baseUrl: params.baseUrl,
    });
  const sendEvent = async (opts: { body: unknown; endpoint: string; errorLabel: string }) => {
    const result = await request<{ event_id?: string }>({
      body: opts.body,
      endpoint: opts.endpoint,
      method: "PUT",
    });
    const eventId = result.body.event_id?.trim();
    if (!eventId) {
      throw new Error(`Matrix ${opts.errorLabel} did not return event_id.`);
    }
    return eventId;
  };

  return {
    async createPrivateRoom(opts: {
      encrypted?: boolean;
      inviteUserIds: string[];
      isDirect?: boolean;
      name: string;
    }) {
      const result = await request<MatrixQaRoomCreateResponse>({
        body: {
          creation_content: { "m.federate": false },
          initial_state: buildMatrixQaRoomInitialState(opts.encrypted),
          invite: opts.inviteUserIds,
          is_direct: opts.isDirect === true,
          name: opts.name,
          preset: "private_chat",
        },
        endpoint: "/_matrix/client/v3/createRoom",
        method: "POST",
      });
      const roomId = result.body.room_id?.trim();
      if (!roomId) {
        throw new Error("Matrix createRoom did not return room_id.");
      }
      return roomId;
    },
    async primeRoom() {
      if (syncObserver) {
        return await syncObserver.prime();
      }
      return await primeMatrixQaRoom({
        accessToken: params.accessToken,
        baseUrl: params.baseUrl,
      });
    },
    async registerWithToken(opts: {
      deviceName: string;
      localpart: string;
      password: string;
      registrationToken: string;
    }) {
      let auth: Record<string, unknown> | undefined;
      const baseBody = {
        inhibit_login: false,
        initial_device_display_name: opts.deviceName,
        password: opts.password,
        username: opts.localpart,
      };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await request<MatrixQaRegisterResponse | MatrixQaUiaaResponse>({
          accessToken: undefined,
          body: {
            ...baseBody,
            ...(auth ? { auth } : {}),
          },
          endpoint: "/_matrix/client/v3/register",
          method: "POST",
          okStatuses: [200, 401],
          timeoutMs: 30_000,
        });
        if (response.status === 200) {
          return buildRegisteredAccount({
            localpart: opts.localpart,
            password: opts.password,
            response: response.body as MatrixQaRegisterResponse,
          });
        }
        auth = resolveNextRegistrationAuth({
          registrationToken: opts.registrationToken,
          response: response.body as MatrixQaUiaaResponse,
        });
      }
      throw new Error(
        `Matrix registration for ${opts.localpart} did not complete after 4 attempts.`,
      );
    },
    async loginWithPassword(opts: {
      deviceName: string;
      localpart?: string;
      password: string;
      userId?: string;
    }) {
      const result = await request<MatrixQaRegisterResponse>({
        accessToken: undefined,
        body: {
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: resolveMatrixQaLoginUser(opts),
          },
          initial_device_display_name: opts.deviceName,
          password: opts.password,
        },
        endpoint: "/_matrix/client/v3/login",
        method: "POST",
        timeoutMs: 30_000,
      });
      return buildRegisteredAccount({
        localpart: opts.localpart ?? opts.userId ?? "",
        password: opts.password,
        response: result.body,
      });
    },
    async sendTextMessage(
      opts: Parameters<typeof buildMatrixQaMessageContent>[0] & { roomId: string },
    ) {
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixQaMessageContent(opts),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        errorLabel: "sendMessage",
      });
    },
    async sendReplacementMessage(
      opts: Parameters<typeof buildMatrixQaReplacementMessageContent>[0] & { roomId: string },
    ) {
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixQaReplacementMessageContent(opts),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        errorLabel: "sendReplacementMessage",
      });
    },
    async sendMediaMessage(
      opts: Omit<Parameters<typeof buildMatrixQaMediaMessageContent>[0], "size" | "url"> & {
        buffer: Buffer;
        roomId: string;
      },
    ) {
      const { accessToken, baseUrl } = params;
      const { buffer, contentType, fileName: uploadFileName } = opts;
      async function uploadMatrixQaContent() {
        const url = new URL("/_matrix/media/v3/upload", baseUrl);
        const fileName = uploadFileName?.trim();
        if (fileName) {
          url.searchParams.set("filename", fileName);
        }
        const uploadBody: Uint8Array<ArrayBuffer> =
          buffer.buffer instanceof ArrayBuffer
            ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            : Uint8Array.from(buffer);
        const { response, release } = await fetchWithSsrFGuard({
          url: url.href,
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-matrix-media-upload",
          init: {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": contentType ?? "application/octet-stream",
              ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            },
            body: uploadBody,
            signal: AbortSignal.timeout(20_000),
          },
        });
        try {
          const body = (await readMatrixQaJsonResponse(response)) as {
            content_uri?: string;
            error?: string;
          };
          if (response.status !== 200) {
            throw new Error(
              body.error ?? `Matrix media upload failed with status ${response.status}`,
            );
          }
          const contentUri = body.content_uri?.trim();
          if (!contentUri) {
            throw new Error("Matrix media upload did not return content_uri.");
          }
          return contentUri;
        } finally {
          await release();
        }
      }
      const contentUri = await uploadMatrixQaContent();
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixQaMediaMessageContent({
          ...opts,
          size: opts.buffer.byteLength,
          url: contentUri,
        }),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        errorLabel: "sendMediaMessage",
      });
    },
    async redactEvent(opts: { eventId: string; reason?: string; roomId: string }) {
      const txnId = randomUUID();
      const reason = opts.reason?.trim();
      return await sendEvent({
        body: reason ? { reason } : {},
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/redact/${encodeURIComponent(opts.eventId)}/${encodeURIComponent(txnId)}`,
        errorLabel: "redactEvent",
      });
    },
    async sendReaction(opts: { emoji: string; messageId: string; roomId: string }) {
      const txnId = randomUUID();
      return await sendEvent({
        body: buildMatrixReactionRelation(opts.messageId, opts.emoji),
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.reaction/${encodeURIComponent(txnId)}`,
        errorLabel: "sendReaction",
      });
    },
    async joinRoom(roomId: string) {
      const result = await request<{ room_id?: string }>({
        body: {},
        endpoint: `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
        method: "POST",
      });
      return result.body.room_id?.trim() || roomId;
    },
    async inviteUserToRoom(opts: { roomId: string; userId: string }) {
      await request<Record<string, never>>({
        body: {
          user_id: opts.userId,
        },
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/invite`,
        method: "POST",
      });
    },
    async kickUserFromRoom(opts: { reason?: string; roomId: string; userId: string }) {
      await request<Record<string, never>>({
        body: {
          user_id: opts.userId,
          ...(opts.reason?.trim() ? { reason: opts.reason.trim() } : {}),
        },
        endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/kick`,
        method: "POST",
      });
    },
    waitForOptionalRoomEvent(opts: MatrixQaClientRoomEventWaitParams) {
      return resolveRoomObserver(opts).waitForOptionalRoomEvent(opts);
    },
    async waitForRoomEvent(opts: MatrixQaClientRoomEventWaitParams) {
      return await resolveRoomObserver(opts).waitForRoomEvent(opts);
    },
  };
}

export async function provisionMatrixQaRoom(params: {
  baseUrl: string;
  topology?: MatrixQaTopologySpec;
  roomName: string;
  driverLocalpart: string;
  observerLocalpart: string;
  registrationToken: string;
  sutLocalpart: string;
}) {
  const anonClient = createMatrixQaClient({
    baseUrl: params.baseUrl,
  });
  const registerActor = (role: MatrixQaParticipantRole, deviceName: string) =>
    anonClient.registerWithToken({
      deviceName,
      localpart: params[`${role}Localpart`],
      password: `${role}-${randomUUID()}`,
      registrationToken: params.registrationToken,
    });
  const [driver, sut, observer] = await Promise.all([
    registerActor("driver", "OpenClaw Matrix QA Driver"),
    registerActor("sut", "OpenClaw Matrix QA SUT"),
    registerActor("observer", "OpenClaw Matrix QA Observer"),
  ]);
  const accounts = { driver, observer, sut };
  const baseUrl = params.baseUrl;
  const spec =
    params.topology ??
    ({
      defaultRoomKey: "main",
      rooms: [
        {
          key: "main",
          kind: "group",
          members: ["driver", "observer", "sut"],
          name: params.roomName,
          requireMention: true,
        },
      ],
    } satisfies MatrixQaTopologySpec);
  async function provisionMatrixQaTopology(): Promise<MatrixQaProvisionedTopology> {
    const rooms = [];

    for (const room of spec.rooms) {
      const memberRoles = uniqueValues(room.members);
      const [creatorRole, ...inviteeRoles] = memberRoles;
      if (creatorRole === undefined) {
        throw new Error("Matrix QA room provisioning requires at least one member");
      }
      const creatorClient = createMatrixQaClient({
        accessToken: accounts[creatorRole].accessToken,
        baseUrl,
      });
      const roomId = await creatorClient.createPrivateRoom({
        encrypted: room.encrypted === true,
        inviteUserIds: inviteeRoles.map((role) => accounts[role].userId),
        isDirect: room.kind === "dm",
        name: room.name,
      });
      await Promise.all(
        inviteeRoles.map((role) =>
          createMatrixQaClient({
            accessToken: accounts[role].accessToken,
            baseUrl,
          }).joinRoom(roomId),
        ),
      );
      rooms.push({
        encrypted: room.encrypted === true,
        key: room.key,
        kind: room.kind,
        memberRoles,
        memberUserIds: memberRoles.map((role) => accounts[role].userId),
        name: room.name,
        requireMention: room.kind === "group" && room.requireMention !== false,
        roomId,
      });
    }

    const defaultRoom = findMatrixQaProvisionedRoom(
      {
        defaultRoomId: "",
        defaultRoomKey: spec.defaultRoomKey,
        rooms,
      },
      spec.defaultRoomKey,
    );

    return {
      defaultRoomId: defaultRoom.roomId,
      defaultRoomKey: spec.defaultRoomKey,
      rooms,
    };
  }
  const topology = await provisionMatrixQaTopology();
  // A /sync cursor acknowledges device messages even when a room-only reader
  // ignores them. Passive readers must never share the encrypted actor's device.
  const createObservationAccount = (account: MatrixQaRegisteredAccount) =>
    anonClient.loginWithPassword({
      deviceName: "OpenClaw Matrix QA Room Observation",
      password: account.password,
      userId: account.userId,
    });
  const [driverObservation, observerObservation] = await Promise.all([
    createObservationAccount(driver),
    createObservationAccount(observer),
  ]);
  return {
    driver,
    observer,
    observationAccounts: { driver: driverObservation, observer: observerObservation },
    roomId: topology.defaultRoomId,
    sut,
    topology,
  } satisfies MatrixQaProvisionResult;
}
