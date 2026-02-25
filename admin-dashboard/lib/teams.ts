export interface Team {
  subdomain: string;
  owner: string;
  lang: string;
  tags: string[];
}

export interface TeamData {
  teams: Team[];
  crossAccess: Record<string, string[]>;
}

export const TEAM_DATA: TeamData = {
  teams: [
    { subdomain: "aai", owner: "DS", lang: "de", tags: ["ds-laptop", "ds-phone"] },
    { subdomain: "as", owner: "Arnela Selmanovic", lang: "bs", tags: ["arnela", "arnela-agents"] },
    { subdomain: "ac", owner: "Arman Canic", lang: "bs", tags: ["armaan", "armaan-agents"] },
    { subdomain: "hd", owner: "Hase Dervisevic", lang: "bs", tags: ["hase", "hase-agents"] },
    { subdomain: "mb", owner: "Mersiha Basagic", lang: "bs", tags: ["mersiha", "mersiha-agents"] },
    { subdomain: "dk", owner: "Dino Kismic", lang: "bs", tags: ["dino", "dino-agents"] },
    { subdomain: "tk", owner: "Tarik Komic", lang: "bs", tags: ["tarik", "tarik-agents"] },
  ],
  crossAccess: {
    arnela: ["mersiha-agents", "hase-agents"],
    armaan: ["mersiha-agents", "hase-agents"],
  },
};

export interface HealthStatus {
  status: "online" | "offline" | "loading";
  agents: {
    name: string;
    status: "online" | "offline";
  }[];
  swarm?: {
    active: number;
    total: number;
  };
}

export interface TeamHealth extends Team {
  health: HealthStatus;
}
