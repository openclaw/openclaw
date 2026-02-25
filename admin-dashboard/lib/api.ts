import axios from "axios";
import { TEAM_DATA, type Team, type HealthStatus } from "./teams";

const API_BASE = "https://{subdomain}.activi.io";

export async function fetchHealth(subdomain: string): Promise<HealthStatus> {
  try {
    const url = API_BASE.replace("{subdomain}", subdomain);
    const [healthRes, swarmRes] = await Promise.allSettled([
      axios.get(`${url}/api/health`),
      axios.get(`${url}/api/swarm/status`),
    ]);

    const health = healthRes.status === "fulfilled" ? healthRes.value.data : null;
    const swarm = swarmRes.status === "fulfilled" ? swarmRes.value.data : null;

    return {
      status: health ? "online" : "offline",
      agents: health?.agents || [],
      swarm: swarm
        ? {
            active: swarm.active || 0,
            total: swarm.total || 0,
          }
        : undefined,
    };
  } catch (error) {
    return {
      status: "offline",
      agents: [],
    };
  }
}

export async function fetchAllHealth(): Promise<Record<string, HealthStatus>> {
  const results = await Promise.all(
    TEAM_DATA.teams.map(async (team) => ({
      subdomain: team.subdomain,
      health: await fetchHealth(team.subdomain),
    }))
  );

  return Object.fromEntries(results.map((r) => [r.subdomain, r.health]));
}

export async function installSkill(subdomain: string, skillName: string): Promise<void> {
  const url = API_BASE.replace("{subdomain}", subdomain);
  await axios.post(`${url}/api/skills/install`, { skill: skillName });
}

export async function removeSkill(subdomain: string, skillName: string): Promise<void> {
  const url = API_BASE.replace("{subdomain}", subdomain);
  await axios.delete(`${url}/api/skills/${skillName}`);
}

export async function deployConfig(subdomain: string, config: unknown): Promise<void> {
  const url = API_BASE.replace("{subdomain}", subdomain);
  await axios.post(`${url}/api/config`, config);
}

export async function restartTeam(subdomain: string): Promise<void> {
  const url = API_BASE.replace("{subdomain}", subdomain);
  await axios.post(`${url}/api/restart`);
}
