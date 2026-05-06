import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { GatewayEndpoint, GATEWAY_PROTOCOL_VERSION } from '../model/GatewayModels';
import { DeviceAuthStore, DeviceAuth } from './DeviceAuthStore';
import { DeviceIdentityStore } from './DeviceIdentityStore';
import { DeviceAuthPayload } from './DeviceAuthPayload';
import { i18n } from '@kit.LocalizationKit';

// Define types for event handlers
export type EventHandler = (event: string, payloadJson: string) => void;
export type InvokeHandler = (command: string, paramsJson: string) => Promise<void>;
export type ConnectedHandler = (name: string, remote: string, mainSessionKey: string) => void;
export type DisconnectedHandler = (message: string) => void;

class NodeInvokeRequest {
  id: string = '';
  nodeId: string = '';
  command: string = '';
  paramsJSON?: string;
  params?: Object;
}

// Interface for WebSocket mock
interface IWebSocket {
  on(event: string, callback: (data: string | ArrayBuffer) => void): void;
  connect(url: string): Promise<void>;
  send(data: string): Promise<void>;
  close(): Promise<void>;
}

// Request handler interface
interface RequestHandler {
  resolve: (value: GatewayResponse) => void;
  reject: (reason: Error) => void;
}

// Handlers parameter interface
interface GatewayHandlers {
  onConnected?: ConnectedHandler;
  onDisconnected?: DisconnectedHandler;
  onEvent?: EventHandler;
  onInvoke?: InvokeHandler;
}

class GatewayResponse {
  id: string = '';
  result: GatewayResult = new GatewayResult();
  error?: GatewayError;
  event?: string;
  payload?: GatewayPayload;
}

class GatewayResult {
  success: boolean = false;
  mainSessionKey?: string;
}

class GatewayError {
  message: string = '';
}

// Gateway payload interface
interface GatewayPayload {
  id?: string;
  nodeId?: string;
  command?: string;
  paramsJson?: string;
  paramsJSON?: string;
  params?: Object;
}

interface GatewayFrame {
  type?: string;
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: Object;
  payloadJSON?: string;
  error?: GatewayFrameError;
}

class GatewayFrameError extends GatewayError {
  code?: string;
}

class NodeEventParams {
  event: string = '';
  payload?: Object;
  payloadJSON?: string;
}

class NodeInvokeResultError {
  code: string = '';
  message: string = '';
}

class NodeInvokeResultParams {
  id: string = '';
  nodeId: string = '';
  ok: boolean = false;
  payload?: Object;
  payloadJSON?: string;
  error?: NodeInvokeResultError;
}

class ConnectAuthParams {
  token?: string;
  password?: string;
}

class ConnectDeviceParams {
  id: string = '';
  publicKey: string = '';
  signature: string = '';
  signedAt: number = 0;
  nonce: string = '';
}

class ConnectClientParams {
  id: string = '';
  displayName: string = '';
  version: string = '';
  platform: string = '';
  mode: string = '';
  instanceId: string = '';
  deviceFamily: string = '';
}

class ConnectPermissionsParams {}

class ConnectRequestParams {
  minProtocol: number = 0;
  maxProtocol: number = 0;
  client: ConnectClientParams = new ConnectClientParams();
  role: string = '';
  scopes: string[] = [];
  caps: string[] = [];
  commands: string[] = [];
  permissions: ConnectPermissionsParams = new ConnectPermissionsParams();
  locale: string = '';
  userAgent: string = '';
  auth?: ConnectAuthParams;
  device?: ConnectDeviceParams;
}

class RequestFrame {
  type: string = 'req';
  id: string = '';
  method: string = '';
  params?: Object;
}

// Auth payload interface
interface AuthPayload {
  instanceId: string;
  displayName: string;
  deviceAuth: DeviceAuth | null;
  protocolVersion: number;
}

// Auth response interface
interface AuthResponse {
  mainSessionKey?: string;
}

// Invoke payload interface
interface InvokePayload {
  command: string;
  paramsJson: string;
}

/**
 * Gateway Session for HarmonyOS
 * Handles WebSocket communication with the gateway
 */
export class GatewaySession {
  private ws: IWebSocket | null = null;
  private connected: boolean = false;
  private connecting: boolean = false;
  private suppressNextCloseDisconnectNotice: boolean = false;
  private connectToken: string = '';
  private connectPassword: string = '';
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000;
  private reconnectTimer: number = -1;
  private desiredEndpoint: GatewayEndpoint | null = null;
  private desiredToken: string = '';
  private desiredPassword: string = '';
  private manualDisconnect: boolean = false;
  private requestMap: Map<string, RequestHandler> = new Map();
  private requestCounter: number = 0;
  private connectNoncePromise: Promise<string> | null = null;
  private resolveConnectNonce: ((value: string) => void) | null = null;
  private rejectConnectNonce: ((reason?: Error) => void) | null = null;

  // Handlers
  private onConnectedHandler?: ConnectedHandler;
  private onDisconnectedHandler?: DisconnectedHandler;
  private onEventHandler?: EventHandler;
  private onInvokeHandler?: InvokeHandler;

  // Dependencies
  private deviceIdentityStore: DeviceIdentityStore;
  private deviceAuthStore: DeviceAuthStore;

  constructor(deviceIdentityStoreParam: DeviceIdentityStore, deviceAuthStoreParam: DeviceAuthStore) {
    this.deviceIdentityStore = deviceIdentityStoreParam;
    this.deviceAuthStore = deviceAuthStoreParam;
  }

  /**
   * Set handlers for gateway events
   */
  setHandlers(handlersParam: GatewayHandlers): void {
    this.onConnectedHandler = handlersParam.onConnected;
    this.onDisconnectedHandler = handlersParam.onDisconnected;
    this.onEventHandler = handlersParam.onEvent;
    this.onInvokeHandler = handlersParam.onInvoke;
  }

  private resetConnectChallengeWaiter(): void {
    this.connectNoncePromise = new Promise<string>((resolve, reject) => {
      this.resolveConnectNonce = resolve;
      this.rejectConnectNonce = reject;
    });
  }

  private failPendingRequests(message: string): void {
    const entries = Array.from(this.requestMap.entries());
    this.requestMap.clear();
    for (let i = 0; i < entries.length; i++) {
      entries[i][1].reject(new Error(message));
    }
  }

  private awaitConnectNonce(timeoutMs: number = 2000): Promise<string> {
    if (!this.connectNoncePromise) {
      this.resetConnectChallengeWaiter();
    }

    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('connect challenge timeout'));
      }, timeoutMs);

      (this.connectNoncePromise as Promise<string>).then((nonce: string) => {
        clearTimeout(timeoutId);
        resolve(nonce);
      }).catch((error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  private extractConnectNonce(payloadJson: string): string {
    const parsed = JSON.parse(payloadJson) as Record<string, Object | string>;
    const nonceValue = parsed['nonce'];
    return typeof nonceValue === 'string' ? nonceValue.trim() : '';
  }

  private buildAuthParams(): ConnectAuthParams | null {
    if (this.connectToken.length > 0) {
      const auth = new ConnectAuthParams();
      auth.token = this.connectToken;
      return auth;
    }
    if (this.connectPassword.length > 0) {
      const auth = new ConnectAuthParams();
      auth.password = this.connectPassword;
      return auth;
    }
    return null;
  }

  private toBase64Url(value: string): string {
    return value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private async buildConnectParams(instanceId: string, displayName: string, deviceAuth: DeviceAuth | null, nonce: string): Promise<string> {
    const client = new ConnectClientParams();
    client.id = 'openclaw-harmonyos';
    client.displayName = displayName || 'HarmonyOS Device';
    client.version = '2026.3.2';
    client.platform = 'harmonyos';
    client.mode = 'ui';
    client.instanceId = instanceId;
    client.deviceFamily = 'HarmonyOS';

    const params = new ConnectRequestParams();
    params.minProtocol = GATEWAY_PROTOCOL_VERSION;
    params.maxProtocol = GATEWAY_PROTOCOL_VERSION;
    params.client = client;
    params.role = 'operator';
    params.scopes = ['operator.read', 'operator.write', 'operator.talk.secrets'];
    params.caps = [];
    params.commands = [];
    params.permissions = new ConnectPermissionsParams();
    try {
      params.locale = i18n.System.getSystemLocale() || 'en-US';
      console.log('System Locale:', params.locale);
    } catch (error) {
      console.error('Error getting locale:', error);
      params.locale = 'en-US';
    }
    params.userAgent = 'OpenClawHarmony/2026.3.2 (HarmonyOS)';

    const auth = this.buildAuthParams();
    if (auth) {
      params.auth = auth;
    }

    const signedAtMs = Date.now();

    if (deviceAuth !== null) {
      const authToken = this.connectToken.length > 0 ? this.connectToken : '';
      const devicePayload = DeviceAuthPayload.buildV3(
        deviceAuth.deviceId.trim(),
        client.id,
        client.mode,
        params.role,
        params.scopes,
        signedAtMs,
        authToken,
        nonce,
        client.platform,
        client.deviceFamily
      );
      const signature = await this.deviceAuthStore.signPayload(devicePayload, deviceAuth);

      if (signature && signature.length > 0) {
        const device = new ConnectDeviceParams();
        device.id = deviceAuth.deviceId.trim();
        device.publicKey = this.toBase64Url(deviceAuth.publicKey);
        device.signature = signature;
        device.signedAt = signedAtMs;
        device.nonce = nonce;
        params.device = device;
      } else {
        console.warn('GatewaySession: Device signature unavailable, skipping device auth payload');
      }
    }

    return JSON.stringify(params);
  }

  private extractServerName(response: GatewayResponse): string {
    const payloadValue = response.payload;
    if (!payloadValue) {
      return 'OpenClaw';
    }

    const payload = payloadValue as Record<string, Object | string>;
    const serverValue = payload['server'];
    if (!serverValue || typeof serverValue === 'string') {
      return 'OpenClaw';
    }

    const server = serverValue as Record<string, Object | string>;
    const host = server['host'];
    return typeof host === 'string' && host.trim().length > 0 ? host : 'OpenClaw';
  }

  private bindSocketHandlers(endpoint: GatewayEndpoint): void {
    if (!this.ws) {
      return;
    }

    this.ws.on('open', (_data: string | ArrayBuffer) => {
      console.info('GatewaySession: WebSocket open for ' + endpoint.host + ':' + endpoint.port);
    });

    this.ws.on('message', (data: string | ArrayBuffer) => {
      const text = typeof data === 'string' ? data : '';
      if (typeof data !== 'string') {
        console.warn(
          'GatewaySession: Received unexpected binary WebSocket frame, length=' +
          (data as ArrayBuffer).byteLength +
          ', discarding'
        );
      }
      console.info('GatewaySession: WebSocket message received, length=' + text.length);
      if (text.length > 0) {
        this.handleMessage(text);
      }
    });

    this.ws.on('close', (data: string | ArrayBuffer) => {
      const reason = typeof data === 'string' && data.length > 0 ? data : 'Socket closed';
      console.warn('GatewaySession: WebSocket close: ' + reason);
      this.connected = false;
      this.connecting = false;
      this.failPendingRequests(reason);
      if (this.rejectConnectNonce) {
        this.rejectConnectNonce(new Error(reason));
      }
      this.ws = null;
      const shouldNotifyDisconnected = !this.suppressNextCloseDisconnectNotice;
      this.suppressNextCloseDisconnectNotice = false;
      if (shouldNotifyDisconnected && this.onDisconnectedHandler) {
        this.onDisconnectedHandler(reason);
      }
      if (!this.manualDisconnect) {
        this.scheduleReconnect(endpoint);
      }
    });

    this.ws.on('error', (data: string | ArrayBuffer) => {
      const errorMsg = typeof data === 'string' && data.length > 0 ? data : 'WebSocket error';
      console.error('GatewaySession: WebSocket error: ' + errorMsg);
      this.connected = false;
      this.connecting = false;
      this.failPendingRequests(errorMsg);
      if (this.rejectConnectNonce) {
        this.rejectConnectNonce(new Error(errorMsg));
      }
      this.suppressNextCloseDisconnectNotice = true;
      this.ws = null;
      if (this.onDisconnectedHandler) {
        this.onDisconnectedHandler('Gateway error: ' + errorMsg);
      }
      if (!this.manualDisconnect) {
        this.scheduleReconnect(endpoint);
      }
    });
  }

  /**
   * Connect to gateway
   */
  async connect(endpoint: GatewayEndpoint, token?: string, password?: string, isReconnectAttempt: boolean = false): Promise<void> {
    if (this.connecting || this.connected) {
      console.info('GatewaySession: Already connecting or connected');
      return;
    }

    this.connecting = true;
    this.connectToken = token ? token.trim() : '';
    this.connectPassword = password ? password.trim() : '';
    this.desiredEndpoint = endpoint;
    this.desiredToken = this.connectToken;
    this.desiredPassword = this.connectPassword;
    this.manualDisconnect = false;
    this.clearReconnectTimer();
    this.resetConnectChallengeWaiter();
    if (!isReconnectAttempt) {
      this.reconnectAttempts = 0;
    }

    try {
      const protocol = endpoint.tlsEnabled ? 'wss' : 'ws';
      const url = protocol + '://' + endpoint.host + ':' + endpoint.port + '/ws';

      console.info(
        'GatewaySession: Connecting to ' + url + ', hasToken=' + (this.connectToken.length > 0) + ', hasPassword=' + (this.connectPassword.length > 0)
      );

      this.ws = new ArkWebSocket();
      this.bindSocketHandlers(endpoint);

      await this.ws.connect(url);

      this.connected = true;
      this.connecting = false;

      // Perform authentication
      await this.performAuthentication(endpoint);
      this.reconnectAttempts = 0;

    } catch (error) {
      const errorMsg: string = error instanceof Error ? error.message : 'Unknown error';
      console.error('GatewaySession: Connection error: ' + errorMsg);
      this.connected = false;
      this.connecting = false;
      const activeSocket = this.ws;
      this.suppressNextCloseDisconnectNotice = activeSocket !== null;
      this.ws = null;
      if (activeSocket) {
        try {
          await activeSocket.close();
        } catch (closeError) {
          const closeErrorMsg: string = closeError instanceof Error ? closeError.message : 'Unknown error';
          console.warn('GatewaySession: Close after connection failure failed: ' + closeErrorMsg);
        }
      }
      throw new Error(errorMsg);
    }
  }

  /**
   * Disconnect from gateway
   */
  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.clearReconnectTimer();

    if (this.ws) {
      try {
        console.info('GatewaySession: Disconnecting from WebSocket');
        await this.ws.close();
      } catch (error) {
        const errorMsg: string = error instanceof Error ? error.message : 'Unknown error';
        console.error('GatewaySession: Close error: ' + errorMsg);
      }
      this.ws = null;
    }

    this.connected = false;
    this.connecting = false;
    this.connectToken = '';
    this.connectPassword = '';
    this.desiredEndpoint = null;
    this.desiredToken = '';
    this.desiredPassword = '';
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer >= 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
  }

  /**
   * Check if connected to gateway
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if connecting to gateway
   */
  isConnecting(): boolean {
    return this.connecting;
  }

  private buildRequestFrame(id: string, method: string, paramsJson?: string): string {
    const frame = new RequestFrame();
    frame.type = 'req';
    frame.id = id;
    frame.method = method;

    if (paramsJson && paramsJson.trim().length > 0) {
      frame.params = JSON.parse(paramsJson) as Object;
    }

    return JSON.stringify(frame);
  }

  /**
   * Send a request to gateway
   */
  async request(method: string, paramsJson?: string): Promise<GatewayResponse> {
    return new Promise<GatewayResponse>((resolve, reject) => {
      if (!this.connected || !this.ws) {
        console.warn('GatewaySession: Rejecting request because socket is not connected, method=' + method);
        reject(new Error('Not connected to gateway'));
        return;
      }

      const id: string = String(++this.requestCounter);
      const paramsLength: number = paramsJson ? paramsJson.length : 0;

      console.info('GatewaySession: Sending request ' + id + ': ' + method + ', paramsLength=' + paramsLength);

      // Add to request map
      this.requestMap.set(id, { resolve, reject });

      let frameJson: string = '';
      try {
        frameJson = this.buildRequestFrame(id, method, paramsJson);
      } catch (error) {
        this.requestMap.delete(id);
        const errorMsg = error instanceof Error ? error.message : 'Invalid request params';
        reject(new Error(errorMsg));
        return;
      }

      this.ws.send(frameJson).then(() => {
        console.info('GatewaySession: Request frame sent for id=' + id + ', method=' + method);
      }).catch((error: Error) => {
        this.requestMap.delete(id);
        reject(error);
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.requestMap.has(id)) {
          this.requestMap.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Send node event
   */
  async sendNodeEvent(event: string, payloadJson: string): Promise<boolean> {
    if (!this.connected || !this.ws) {
      return false;
    }

    try {
      const parsedPayload = payloadJson && payloadJson.trim().length > 0 ? JSON.parse(payloadJson) as Object : undefined;
      const params = new NodeEventParams();
      params.event = event;
      if (parsedPayload !== undefined) {
        params.payload = parsedPayload;
        params.payloadJSON = payloadJson;
      }
      await this.request('node.event', JSON.stringify(params));
      console.info('GatewaySession: Node event sent: ' + event);
      return true;
    } catch (error) {
      console.error('GatewaySession: Send event error:', error instanceof Error ? error : new Error('Send failed'));
      return false;
    }
  }

  /**
   * Get current canvas host URL
   */
  currentCanvasHostUrl(): string | null {
    return null;
  }

  /**
   * Navigate to canvas page
   */
  navigateToCanvas(): void {
    console.info('GatewaySession: Navigate to canvas - not implemented yet');
  }

  /**
   * Show connection status message
   */
  showConnectionStatus(message: string): void {
    console.info('GatewaySession: Connection status - ' + message);
  }

  /**
   * Refresh node canvas capability
   */
  async refreshNodeCanvasCapability(): Promise<void> {
    console.info('GatewaySession: Refreshing node canvas capability');
  }

  /**
   * Check if connected (property-style)
   */
  get connectedStatus(): boolean {
    return this.connected;
  }

  /**
   * Private: Perform authentication
   */
  private async performAuthentication(endpoint: GatewayEndpoint): Promise<void> {
    try {
      console.info('GatewaySession: performAuthentication start for ' + endpoint.host + ':' + endpoint.port);
      const instanceId: string = await this.deviceIdentityStore.getInstanceId();
      const displayName: string = await this.deviceIdentityStore.getDisplayName();

      let deviceAuth: DeviceAuth | null = null;
      deviceAuth = await this.deviceAuthStore.getDeviceAuth();

      if (!deviceAuth) {
        deviceAuth = await this.deviceAuthStore.generateDeviceAuth();
      }

      const connectNonce = await this.awaitConnectNonce();
      const connectPayload = await this.buildConnectParams(instanceId, displayName, deviceAuth, connectNonce);

      console.info(
        'GatewaySession: performAuthentication payload ready, hasDeviceAuth=' + (deviceAuth !== null) + ', protocol=' + GATEWAY_PROTOCOL_VERSION
      );

      const response: GatewayResponse = await this.request('connect', connectPayload);
      console.info(
        'GatewaySession: performAuthentication response success=' + response.result.success
      );

      if (!response.result.success) {
        throw new Error(response.error?.message || 'Gateway authentication was rejected');
      }

      const mainSessionKey = this.extractMainSessionKey(response);

      if (this.onConnectedHandler) {
        this.onConnectedHandler(
          this.extractServerName(response),
          endpoint.host,
          mainSessionKey
        );
      }
    } catch (error) {
      const errorMsg: string = error instanceof Error ? error.message : 'Unknown error';
      console.error('GatewaySession: Authentication error:', errorMsg);
      this.connected = false;
      this.connecting = false;
      this.manualDisconnect = true;
      if (this.onDisconnectedHandler) {
        this.onDisconnectedHandler('Authentication failed: ' + errorMsg);
      }
      const activeSocket = this.ws;
      this.suppressNextCloseDisconnectNotice = activeSocket !== null;
      this.ws = null;
      if (activeSocket) {
        try {
          await activeSocket.close();
        } catch (closeError) {
          const closeErrorMsg: string = closeError instanceof Error ? closeError.message : 'Unknown error';
          console.warn('GatewaySession: Close after authentication failure failed: ' + closeErrorMsg);
        }
      }
      throw new Error('Authentication failed: ' + errorMsg);
    }
  }

  /**
   * Private: Extract mainSessionKey from response
   */
  private extractMainSessionKey(response: GatewayResponse): string {
    const payloadValue = response.payload;
    if (payloadValue) {
      const payload = payloadValue as Record<string, Object | string>;
      const snapshotValue = payload['snapshot'];
      if (snapshotValue && typeof snapshotValue !== 'string') {
        const snapshot = snapshotValue as Record<string, Object | string>;
        const sessionDefaultsValue = snapshot['sessionDefaults'];
        if (sessionDefaultsValue && typeof sessionDefaultsValue !== 'string') {
          const sessionDefaults = sessionDefaultsValue as Record<string, Object | string>;
          const mainSessionKey = sessionDefaults['mainSessionKey'];
          if (typeof mainSessionKey === 'string' && mainSessionKey.length > 0) {
            return mainSessionKey;
          }
        }
      }
    }

    if (response && response.result && typeof response.result.mainSessionKey === 'string' && response.result.mainSessionKey.length > 0) {
      return response.result.mainSessionKey;
    }
    throw new Error('Gateway response missing mainSessionKey');
  }

  /**
   * Private: Handle incoming message
   */
  private handleMessage(message: string): void {
    try {
      const data = JSON.parse(message) as GatewayFrame;
      const frameType = data.type || '';

      if (frameType === 'res' && data.id && this.requestMap.has(data.id)) {
        const handler = this.requestMap.get(data.id);
        if (handler) {
          this.requestMap.delete(data.id);

          if (data.error) {
            handler.reject(new Error(data.error.message || 'Unknown error'));
          } else {
            const response = new GatewayResponse();
            response.id = data.id;
            response.result = new GatewayResult();
            response.result.success = data.ok === true;
            response.result.mainSessionKey = undefined;
            response.error = data.error;
            response.payload = data.payload as GatewayPayload;
            handler.resolve(response);
          }
        }
      } else if (frameType === 'event' && data.event) {
        const payloadStr = data.payload !== undefined
          ? JSON.stringify(data.payload)
          : (data.payloadJSON || '{}');

        if (data.event === 'connect.challenge') {
          const nonce = this.extractConnectNonce(payloadStr);
          if (nonce.length > 0 && this.resolveConnectNonce) {
            this.resolveConnectNonce(nonce);
          }
          return;
        }

        if (data.event === 'node.invoke.request') {
          this.handleInvoke(data);
        } else if (this.onEventHandler) {
          this.onEventHandler(data.event, payloadStr);
        }
      }
    } catch (error) {
      const errorMsg: string = error instanceof Error ? error.message : 'Invalid JSON message';
      console.error('GatewaySession: Message parse error:', errorMsg);
    }
  }

  /**
   * Private: Handle invoke request
   */
  private async handleInvoke(frame: GatewayFrame): Promise<void> {
    if (!this.onInvokeHandler) {
      console.warn('GatewaySession: No invoke handler');
      return;
    }

    const payload = this.extractInvokeRequest(frame);
    if (!payload) {
      console.error('GatewaySession: Invalid invoke payload');
      return;
    }

    const paramsJson: string = this.extractInvokeParamsJson(payload);

    try {
      await this.onInvokeHandler(payload.command, paramsJson);
    } catch (error) {
      const errorMsg: string = error instanceof Error ? error.message : 'Unknown error';
      console.error('GatewaySession: Invoke error:', errorMsg);
      try {
        await this.sendInvokeResult(payload.id, payload.nodeId, false, undefined, {
          code: 'invoke_failed',
          message: errorMsg
        });
      } catch (sendError) {
        const sendErrorMsg: string = sendError instanceof Error ? sendError.message : 'Unknown error';
        console.error('GatewaySession: Failed to send invoke failure result:', sendErrorMsg);
      }
      return;
    }

    try {
      await this.sendInvokeResult(payload.id, payload.nodeId, true);
    } catch (error) {
      const errorMsg: string = error instanceof Error ? error.message : 'Unknown error';
      console.error('GatewaySession: Failed to send invoke success result:', errorMsg);
    }
  }

  private extractInvokeRequest(frame: GatewayFrame): NodeInvokeRequest | null {
    const payloadValue = frame.payload;
    if (!payloadValue) {
      return null;
    }
    const payload = payloadValue as GatewayPayload;
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId.trim() : '';
    const command = typeof payload.command === 'string' ? payload.command.trim() : '';
    if (id.length === 0 || nodeId.length === 0 || command.length === 0) {
      return null;
    }
    const request = new NodeInvokeRequest();
    request.id = id;
    request.nodeId = nodeId;
    request.command = command;
    request.paramsJSON = typeof payload.paramsJSON === 'string' ? payload.paramsJSON : payload.paramsJson;
    request.params = payload.params;
    return request;
  }

  private extractInvokeParamsJson(payload: NodeInvokeRequest): string {
    const paramsJson = typeof payload.paramsJSON === 'string' ? payload.paramsJSON.trim() : '';
    if (paramsJson.length > 0) {
      return paramsJson;
    }
    if (payload.params !== undefined) {
      return JSON.stringify(payload.params);
    }
    return '{}';
  }

  private async sendInvokeResult(
    id: string,
    nodeId: string,
    ok: boolean,
    payloadJson?: string,
    error?: GatewayFrameError
  ): Promise<void> {
    const params = new NodeInvokeResultParams();
    params.id = id;
    params.nodeId = nodeId;
    params.ok = ok;
    if (payloadJson && payloadJson.trim().length > 0) {
      params.payloadJSON = payloadJson;
      params.payload = JSON.parse(payloadJson) as Object;
    }
    if (error) {
      const invokeError = new NodeInvokeResultError();
      invokeError.code = error.code || 'invoke_failed';
      invokeError.message = error.message || 'Invoke failed';
      params.error = invokeError;
    }
    await this.request('node.invoke.result', JSON.stringify(params));
  }

  /**
   * Private: Schedule reconnection
   */
  private scheduleReconnect(endpoint: GatewayEndpoint): void {
    if (this.manualDisconnect || !this.desiredEndpoint) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.info('GatewaySession: Max reconnect attempts reached');
      return;
    }

    if (this.reconnectTimer >= 0) {
      return;
    }

    const delay: number = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.info('GatewaySession: Scheduling reconnect in ' + delay + 'ms (attempt ' + this.reconnectAttempts + ')');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      const target = this.desiredEndpoint;
      if (!target || this.connected || this.connecting || this.manualDisconnect) {
        return;
      }

      this.connect(target, this.desiredToken, this.desiredPassword, true).catch((error: Error) => {
        const errorMsg = error instanceof Error ? error.message : 'Reconnect failed';
        console.error('GatewaySession: Reconnect failed: ' + errorMsg);
        this.scheduleReconnect(target);
      });
    }, delay);
  }
}

class ArkWebSocket implements IWebSocket {
  private socket: webSocket.WebSocket = webSocket.createWebSocket();
  private listeners: Map<string, Array<(data: string | ArrayBuffer) => void>> = new Map();

  constructor() {
    this.socket.on('open', (_err: BusinessError, _value: Object) => {
      this.emit('open', '');
    });
    this.socket.on('message', (_err: BusinessError, value: string | ArrayBuffer) => {
      this.emit('message', value);
    });
    this.socket.on('close', (_err: BusinessError, value: webSocket.CloseResult) => {
      this.emit('close', value.reason || '');
    });
    this.socket.on('error', (err: BusinessError) => {
      this.emit('error', JSON.stringify(err));
    });
  }

  on(event: string, callback: (data: string | ArrayBuffer) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(callback);
    this.listeners.set(event, existing);
  }

  connect(url: string): Promise<void> {
    return this.socket.connect(url).then((): void => {});
  }

  send(data: string): Promise<void> {
    return this.socket.send(data).then((): void => {});
  }

  close(): Promise<void> {
    return this.socket.close().then((): void => {});
  }

  private emit(event: string, data: string | ArrayBuffer): void {
    const callbacks = this.listeners.get(event) || [];
    for (let i = 0; i < callbacks.length; i++) {
      callbacks[i](data);
    }
  }
}
