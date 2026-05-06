import { securePrefs } from '../common/SecurePrefs';

/**
 * Device Identity data
 */
export interface DeviceIdentity {
  instanceId: string;
  displayName: string;
  createdAt: number;
}

/**
 * Device Identity Store for HarmonyOS
 * Handles device identity information
 */
export class DeviceIdentityStore {
  private static instance: DeviceIdentityStore;
  
  private constructor() {}
  
  static getInstance(): DeviceIdentityStore {
    if (!DeviceIdentityStore.instance) {
      DeviceIdentityStore.instance = new DeviceIdentityStore();
    }
    return DeviceIdentityStore.instance;
  }
  
  /**
   * Get device identity
   */
  async getDeviceIdentity(): Promise<DeviceIdentity | null> {
    try {
      const instanceId = await securePrefs.getInstanceId();
      const displayName = await securePrefs.getDisplayName();

      if (!instanceId) {
        return null;
      }

      const storedCreatedAt = await securePrefs.getIdentityCreatedAt();
      return {
        instanceId,
        displayName,
        createdAt: storedCreatedAt > 0 ? storedCreatedAt : Date.now()
      };
    } catch (error) {
      console.error('DeviceIdentityStore: Get identity error:', error);
      return null;
    }
  }
  
  /**
   * Update device display name
   */
  async updateDisplayName(name: string): Promise<void> {
    await securePrefs.setDisplayName(name);
  }
  
  /**
   * Get instance ID
   */
  async getInstanceId(): Promise<string> {
    return await securePrefs.getInstanceId();
  }
  
  /**
   * Get display name
   */
  async getDisplayName(): Promise<string> {
    return await securePrefs.getDisplayName();
  }
}

export const deviceIdentityStore = DeviceIdentityStore.getInstance();
