/**
 * Tesla Fleet API client.
 *
 * Handles OAuth token lifecycle (refresh) and wraps the Fleet API endpoints
 * used by the tesla tool. Uses `undici` (already a core dep) for HTTP.
 *
 * Reference: https://developer.tesla.com/docs/fleet-api
 */

const REGION_HOSTS: Record<string, string> = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.com",
};

const AUTH_HOST = "https://auth.tesla.com";

/** Minimal token pair returned from OAuth token exchange. */
export type TeslaTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
};

export type TeslaClientConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region?: string;
};

export type VehicleInfo = {
  id: number;
  vehicleId: number;
  vin: string;
  displayName: string;
  state: string;
};

export type ChargeState = {
  batteryLevel: number;
  batteryRange: number;
  chargingState: string;
  chargePortOpen: boolean;
  chargeRateKw: number;
  minutesToFullCharge: number;
  chargeLimitPercent: number;
};

export type ClimateState = {
  insideTemp: number;
  outsideTemp: number;
  driverTempSetting: number;
  passengerTempSetting: number;
  isClimateOn: boolean;
  seatHeaterLeft: number;
  seatHeaterRight: number;
};

export type DriveState = {
  latitude: number;
  longitude: number;
  heading: number;
  speed: number | null;
  shiftState: string | null;
};

export type VehicleState = {
  locked: boolean;
  odometer: number;
  softwareUpdate: { status: string; version: string };
  sentryMode: boolean;
  frunkOpen: boolean;
  trunkOpen: boolean;
  windowsOpen: boolean;
};

export type VehicleStatus = {
  vehicle: VehicleInfo;
  charge: ChargeState;
  climate: ClimateState;
  drive: DriveState;
  vehicleState: VehicleState;
};

/** Thrown for known Fleet API errors. */
export class TeslaApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly apiError: string,
    message: string,
  ) {
    super(message);
    this.name = "TeslaApiError";
  }
}

export class TeslaClient {
  private tokens: TeslaTokens | null = null;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private initialRefreshToken: string;

  constructor(config: TeslaClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.initialRefreshToken = config.refreshToken;
    const region = config.region ?? "na";
    this.baseUrl = REGION_HOSTS[region] ?? REGION_HOSTS.na!;
  }

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  private async ensureAccessToken(): Promise<string> {
    if (this.tokens && Date.now() < this.tokens.expiresAtMs - 60_000) {
      return this.tokens.accessToken;
    }
    await this.refreshAccessToken();
    return this.tokens!.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    const refreshToken = this.tokens?.refreshToken ?? this.initialRefreshToken;
    const res = await fetch(`${AUTH_HOST}/oauth2/v3/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TeslaApiError(
        res.status,
        "token_refresh_failed",
        `Token refresh failed (${res.status}): ${text}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAtMs: Date.now() + data.expires_in * 1000,
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.ensureAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TeslaApiError(
        res.status,
        "api_error",
        `GET ${path} failed (${res.status}): ${text}`,
      );
    }
    const body = (await res.json()) as { response: T };
    return body.response;
  }

  private async apiPost<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    const token = await this.ensureAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TeslaApiError(
        res.status,
        "api_error",
        `POST ${path} failed (${res.status}): ${text}`,
      );
    }
    const json = (await res.json()) as { response: T };
    return json.response;
  }

  // ---------------------------------------------------------------------------
  // Vehicle discovery
  // ---------------------------------------------------------------------------

  async listVehicles(): Promise<VehicleInfo[]> {
    const vehicles = await this.apiGet<
      Array<{
        id: number;
        vehicle_id: number;
        vin: string;
        display_name: string;
        state: string;
      }>
    >("/api/1/vehicles");

    return vehicles.map((v) => ({
      id: v.id,
      vehicleId: v.vehicle_id,
      vin: v.vin,
      displayName: v.display_name,
      state: v.state,
    }));
  }

  async resolveVehicleId(vin?: string): Promise<number> {
    const vehicles = await this.listVehicles();
    if (vehicles.length === 0) {
      throw new Error("No vehicles found on your Tesla account.");
    }
    if (vin) {
      const match = vehicles.find((v) => v.vin.toLowerCase() === vin.toLowerCase());
      if (!match) {
        const available = vehicles.map((v) => `${v.vin} (${v.displayName})`).join(", ");
        throw new Error(`VIN ${vin} not found. Available: ${available}`);
      }
      return match.id;
    }
    return vehicles[0]!.id;
  }

  // ---------------------------------------------------------------------------
  // Wake
  // ---------------------------------------------------------------------------

  async wakeUp(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/wake_up`);
    // Wait for the vehicle to come online (up to 30s)
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      try {
        const vehicles = await this.listVehicles();
        const v = vehicles.find((veh) => veh.id === vehicleId);
        if (v?.state === "online") {
          return;
        }
      } catch {
        // Retry
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status / Data
  // ---------------------------------------------------------------------------

  async getVehicleData(vehicleId: number): Promise<VehicleStatus> {
    const data = await this.apiGet<Record<string, unknown>>(
      `/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=charge_state;climate_state;drive_state;vehicle_state`,
    );

    const cs = data.charge_state as Record<string, unknown>;
    const cl = data.climate_state as Record<string, unknown>;
    const ds = data.drive_state as Record<string, unknown>;
    const vs = data.vehicle_state as Record<string, unknown>;
    const sw = (vs?.software_update ?? {}) as Record<string, unknown>;

    return {
      vehicle: {
        id: data.id as number,
        vehicleId: data.vehicle_id as number,
        vin: data.vin as string,
        displayName: data.display_name as string,
        state: data.state as string,
      },
      charge: {
        batteryLevel: cs?.battery_level as number,
        batteryRange: cs?.battery_range as number,
        chargingState: cs?.charging_state as string,
        chargePortOpen: cs?.charge_port_door_open as boolean,
        chargeRateKw: cs?.charger_power as number,
        minutesToFullCharge: cs?.minutes_to_full_charge as number,
        chargeLimitPercent: cs?.charge_limit_soc as number,
      },
      climate: {
        insideTemp: cl?.inside_temp as number,
        outsideTemp: cl?.outside_temp as number,
        driverTempSetting: cl?.driver_temp_setting as number,
        passengerTempSetting: cl?.passenger_temp_setting as number,
        isClimateOn: cl?.is_climate_on as boolean,
        seatHeaterLeft: cl?.seat_heater_left as number,
        seatHeaterRight: cl?.seat_heater_right as number,
      },
      drive: {
        latitude: ds?.latitude as number,
        longitude: ds?.longitude as number,
        heading: ds?.heading as number,
        speed: (ds?.speed as number) ?? null,
        shiftState: (ds?.shift_state as string) ?? null,
      },
      vehicleState: {
        locked: vs?.locked as boolean,
        odometer: vs?.odometer as number,
        softwareUpdate: {
          status: sw.status as string,
          version: sw.version as string,
        },
        sentryMode: vs?.sentry_mode as boolean,
        frunkOpen: (vs?.ft as number) !== 0,
        trunkOpen: (vs?.rt as number) !== 0,
        windowsOpen:
          (vs?.fd_window as number) !== 0 ||
          (vs?.fp_window as number) !== 0 ||
          (vs?.rd_window as number) !== 0 ||
          (vs?.rp_window as number) !== 0,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async lock(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/door_lock`);
  }

  async unlock(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/door_unlock`);
  }

  async honkHorn(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/honk_horn`);
  }

  async flashLights(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/flash_lights`);
  }

  async startClimate(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/auto_conditioning_start`);
  }

  async stopClimate(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/auto_conditioning_stop`);
  }

  async setTemperature(
    vehicleId: number,
    driverTempC: number,
    passengerTempC?: number,
  ): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/set_temps`, {
      driver_temp: driverTempC,
      passenger_temp: passengerTempC ?? driverTempC,
    });
  }

  async setSeatHeater(vehicleId: number, seat: number, level: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/remote_seat_heater_request`, {
      heater: seat,
      level,
    });
  }

  async startCharging(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/charge_start`);
  }

  async stopCharging(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/charge_stop`);
  }

  async setChargeLimit(vehicleId: number, percent: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/set_charge_limit`, {
      percent: Math.max(50, Math.min(100, percent)),
    });
  }

  async openChargePort(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/charge_port_door_open`);
  }

  async closeChargePort(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/charge_port_door_close`);
  }

  async openTrunk(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/actuate_trunk`, {
      which_trunk: "rear",
    });
  }

  async openFrunk(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/actuate_trunk`, {
      which_trunk: "front",
    });
  }

  async ventWindows(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/window_control`, {
      command: "vent",
      lat: 0,
      lon: 0,
    });
  }

  async closeWindows(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/window_control`, {
      command: "close",
      lat: 0,
      lon: 0,
    });
  }

  async setSentryMode(vehicleId: number, on: boolean): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/set_sentry_mode`, { on });
  }

  async remoteStartDrive(vehicleId: number): Promise<void> {
    await this.apiPost(`/api/1/vehicles/${vehicleId}/command/remote_start_drive`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
