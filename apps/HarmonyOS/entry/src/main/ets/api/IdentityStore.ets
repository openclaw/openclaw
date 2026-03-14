/**
 * Identity Store interface for HarmonyOS
 * Manages device identity information
 */
export interface IdentityStore {
  /**
   * Get device instance ID
   */
  getInstanceId(): Promise<string>;
  
  /**
   * Get device display name
   */
  getDisplayName(): Promise<string>;
  
  /**
   * Set device display name
   */
  setDisplayName(name: string): Promise<void>;
}