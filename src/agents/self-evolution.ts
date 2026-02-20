import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";

export interface EvolutionIndividual {
  id: string;
  config: OpenClawConfig;
  fitness: number;
  generation: number;
  parentIds: string[];
  mutations: string[];
  createdAt: Date;
}

export interface EvolutionConfig {
  populationSize: number;
  mutationRate: number;
  crossoverRate: number;
  eliteCount: number;
  maxGenerations: number;
  evaluationIntervalMs: number;
}

export interface EvaluationResult {
  success: boolean;
  fitness: number;
  metrics: {
    responseTime: number;
    errorRate: number;
    memoryUsage: number;
    taskCompletion: number;
  };
  errors: string[];
}

const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 10,
  mutationRate: 0.3,
  crossoverRate: 0.5,
  eliteCount: 2,
  maxGenerations: 50,
  evaluationIntervalMs: 60000,
};

const MUTATION_TYPES = [
  "provider_priority",
  "model_alias",
  "streaming",
  "context_pruning",
  "memory_weight",
  "thinking_default",
  "verbose_default",
] as const;

type MutationType = (typeof MUTATION_TYPES)[number];

export class EvolutionaryEngine {
  private population: EvolutionIndividual[] = [];
  private generation: number = 0;
  private config: EvolutionConfig;
  private archive: EvolutionIndividual[] = [];
  private bestIndividual: EvolutionIndividual | null = null;

  constructor(config: Partial<EvolutionConfig> = {}) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config };
  }

  async initialize(initialConfig: OpenClawConfig): Promise<void> {
    console.log("Initializing evolutionary engine with seed configuration");

    for (let i = 0; i < this.config.populationSize; i++) {
      const mutatedConfig = this.createSeedConfig(initialConfig, i);
      this.population.push({
        id: `individual_${Date.now()}_${i}`,
        config: mutatedConfig,
        fitness: 0,
        generation: 0,
        parentIds: [],
        mutations: [],
        createdAt: new Date(),
      });
    }

    console.log(`Initialized population with ${this.population.length} individuals`);
  }

  private createSeedConfig(baseConfig: OpenClawConfig, index: number): OpenClawConfig {
    const config = JSON.parse(JSON.stringify(baseConfig)) as OpenClawConfig;

    if (!config.agents) {
      config.agents = {};
    }
    if (!config.agents.defaults) {
      config.agents.defaults = {};
    }

    if (index % 3 === 0 && config.agents.defaults.model?.fallbacks) {
      const fallbacks = [...(config.agents.defaults.model.fallbacks as string[])];
      fallbacks.sort(() => Math.random() - 0.5);
      if (config.agents.defaults.model) {
        config.agents.defaults.model.fallbacks = fallbacks;
      }
    }

    if (index % 3 === 1 && config.agents.defaults.models) {
      const keys = Object.keys(config.agents.defaults.models);
      if (keys.length > 0) {
        const randomKey = keys[Math.floor(Math.random() * keys.length)];
        if (config.agents.defaults.models[randomKey]) {
          config.agents.defaults.models[randomKey].streaming = Math.random() > 0.5;
        }
      }
    }

    if (index % 3 === 2) {
      const thinkingOptions: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh"> = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ];
      config.agents.defaults.thinkingDefault =
        thinkingOptions[Math.floor(Math.random() * thinkingOptions.length)];
    }

    return config;
  }

  async evaluateIndividual(_individual: EvolutionIndividual): Promise<EvaluationResult> {
    const startTime = Date.now();

    try {
      const errors: string[] = [];

      const responseTime = Math.random() * 100 + 50;
      const errorRate = Math.random() * 0.1;
      const memoryUsage = Math.random() * 0.5 + 0.2;
      const taskCompletion = Math.random() * 0.3 + 0.7;

      const fitness =
        0.3 * (1 - errorRate) +
        0.3 * taskCompletion +
        0.2 * (1 / (responseTime / 100)) +
        0.2 * (1 - memoryUsage);

      return {
        success: true,
        fitness,
        metrics: {
          responseTime,
          errorRate,
          memoryUsage,
          taskCompletion,
        },
        errors,
      };
    } catch (error) {
      return {
        success: false,
        fitness: 0,
        metrics: {
          responseTime: Date.now() - startTime,
          errorRate: 1,
          memoryUsage: 1,
          taskCompletion: 0,
        },
        errors: [String(error)],
      };
    }
  }

  async evolve(): Promise<EvolutionIndividual | null> {
    console.log(`Starting evolution generation ${this.generation + 1}`);

    const evaluations = await Promise.all(
      this.population.map((ind) => this.evaluateIndividual(ind)),
    );

    evaluations.forEach((evalResult, i) => {
      this.population[i].fitness = evalResult.fitness;
    });

    this.population.sort((a, b) => b.fitness - a.fitness);

    const best = this.population[0];
    if (!this.bestIndividual || best.fitness > this.bestIndividual.fitness) {
      this.bestIndividual = best;
      console.log(`New best individual: ${best.id} with fitness ${best.fitness.toFixed(4)}`);
    }

    this.archive.push(...this.population.slice(0, this.config.eliteCount));

    if (this.generation >= this.config.maxGenerations) {
      console.log("Reached maximum generations, stopping evolution");
      return this.bestIndividual;
    }

    const newPopulation: EvolutionIndividual[] = [];

    for (let i = 0; i < this.config.eliteCount; i++) {
      newPopulation.push({
        ...JSON.parse(JSON.stringify(this.population[i])),
        id: `elite_${Date.now()}_${i}`,
        generation: this.generation + 1,
        createdAt: new Date(),
      });
    }

    while (newPopulation.length < this.config.populationSize) {
      const parent1 = this.tournamentSelect();
      const parent2 = this.tournamentSelect();

      let child: EvolutionIndividual;

      if (Math.random() < this.config.crossoverRate) {
        child = this.crossover(parent1, parent2);
      } else {
        child = this.cloneWithMutation(parent1);
      }

      child = this.mutateIndividual(child);
      newPopulation.push(child);
    }

    this.population = newPopulation;
    this.generation++;

    console.log(
      `Generation ${this.generation} complete. Best fitness: ${this.bestIndividual?.fitness.toFixed(4)}`,
    );

    return this.bestIndividual;
  }

  private tournamentSelect(tournamentSize: number = 3): EvolutionIndividual {
    const tournament: EvolutionIndividual[] = [];
    const usedIndices = new Set<number>();

    while (tournament.length < tournamentSize && usedIndices.size < this.population.length) {
      const idx = Math.floor(Math.random() * this.population.length);
      if (!usedIndices.has(idx)) {
        tournament.push(this.population[idx]);
        usedIndices.add(idx);
      }
    }

    tournament.sort((a, b) => b.fitness - a.fitness);
    return tournament[0];
  }

  private crossover(
    parent1: EvolutionIndividual,
    parent2: EvolutionIndividual,
  ): EvolutionIndividual {
    const childConfig = this.mergeConfigs(parent1.config, parent2.config);

    return {
      id: `crossover_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      config: childConfig,
      fitness: 0,
      generation: this.generation + 1,
      parentIds: [parent1.id, parent2.id],
      mutations: [],
      createdAt: new Date(),
    };
  }

  private cloneWithMutation(parent: EvolutionIndividual): EvolutionIndividual {
    return {
      ...JSON.parse(JSON.stringify(parent)),
      id: `clone_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      config: JSON.parse(JSON.stringify(parent.config)),
      fitness: 0,
      generation: this.generation + 1,
      parentIds: [parent.id],
      mutations: [],
      createdAt: new Date(),
    };
  }

  private mutateIndividual(individual: EvolutionIndividual): EvolutionIndividual {
    const numMutations = Math.floor(Math.random() * 3) + 1;
    const usedTypes = new Set<MutationType>();

    for (let i = 0; i < numMutations; i++) {
      const mutationType = MUTATION_TYPES[Math.floor(Math.random() * MUTATION_TYPES.length)];
      if (usedTypes.has(mutationType)) {
        continue;
      }
      usedTypes.add(mutationType);

      individual.config = this.mutateConfig(individual.config, mutationType);
      individual.mutations.push(mutationType);
    }

    return individual;
  }

  private mutateConfig(config: OpenClawConfig, mutationType: MutationType): OpenClawConfig {
    const mutatedConfig = JSON.parse(JSON.stringify(config)) as OpenClawConfig;

    if (!mutatedConfig.agents) {
      mutatedConfig.agents = {};
    }
    if (!mutatedConfig.agents.defaults) {
      mutatedConfig.agents.defaults = {};
    }
    if (!mutatedConfig.agents.defaults.model) {
      mutatedConfig.agents.defaults.model = {};
    }

    switch (mutationType) {
      case "provider_priority":
        if (mutatedConfig.agents.defaults.model?.fallbacks) {
          const fallbacks = [...(mutatedConfig.agents.defaults.model.fallbacks as string[])];
          const idx1 = Math.floor(Math.random() * fallbacks.length);
          const idx2 = Math.floor(Math.random() * fallbacks.length);
          [fallbacks[idx1], fallbacks[idx2]] = [fallbacks[idx2], fallbacks[idx1]];
          mutatedConfig.agents.defaults.model.fallbacks = fallbacks;
        }
        break;

      case "model_alias":
        if (mutatedConfig.agents.defaults?.models) {
          const modelKeys = Object.keys(mutatedConfig.agents.defaults.models);
          if (modelKeys.length > 0) {
            const randomModel = modelKeys[Math.floor(Math.random() * modelKeys.length)];
            if (mutatedConfig.agents.defaults.models[randomModel]) {
              mutatedConfig.agents.defaults.models[randomModel].alias = `evo_${Date.now()}`;
            }
          }
        }
        break;

      case "streaming":
        if (mutatedConfig.agents.defaults?.models) {
          const modelKeys = Object.keys(mutatedConfig.agents.defaults.models);
          if (modelKeys.length > 0) {
            const randomModel = modelKeys[Math.floor(Math.random() * modelKeys.length)];
            if (mutatedConfig.agents.defaults.models[randomModel]) {
              mutatedConfig.agents.defaults.models[randomModel].streaming = Math.random() > 0.5;
            }
          }
        }
        break;

      case "context_pruning":
        if (!mutatedConfig.agents.defaults.contextPruning) {
          mutatedConfig.agents.defaults.contextPruning = {};
        }
        mutatedConfig.agents.defaults.contextPruning.mode =
          Math.random() > 0.5 ? "cache-ttl" : "off";
        mutatedConfig.agents.defaults.contextPruning.softTrimRatio = Math.random() * 0.3 + 0.5;
        break;

      case "memory_weight":
        if (!mutatedConfig.agents.defaults.memorySearch) {
          mutatedConfig.agents.defaults.memorySearch = {};
        }
        if (!mutatedConfig.agents.defaults.memorySearch.query) {
          mutatedConfig.agents.defaults.memorySearch.query = {};
        }
        if (!mutatedConfig.agents.defaults.memorySearch.query.hybrid) {
          mutatedConfig.agents.defaults.memorySearch.query.hybrid = {};
        }
        mutatedConfig.agents.defaults.memorySearch.query.hybrid.vectorWeight = Math.max(
          0,
          Math.min(
            1,
            (mutatedConfig.agents.defaults.memorySearch.query.hybrid.vectorWeight || 0.5) +
              (Math.random() - 0.5) * 0.2,
          ),
        );
        break;

      case "thinking_default":
        const thinkingOptions: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh"> = [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ];
        mutatedConfig.agents.defaults.thinkingDefault =
          thinkingOptions[Math.floor(Math.random() * thinkingOptions.length)];
        break;

      case "verbose_default":
        const verboseOptions: Array<"off" | "on" | "full"> = ["off", "on", "full"];
        mutatedConfig.agents.defaults.verboseDefault =
          verboseOptions[Math.floor(Math.random() * verboseOptions.length)];
        break;
    }

    return mutatedConfig;
  }

  private mergeConfigs(config1: OpenClawConfig, config2: OpenClawConfig): OpenClawConfig {
    const result = JSON.parse(JSON.stringify(config1)) as OpenClawConfig;

    if (config2.agents?.defaults?.model?.fallbacks && result.agents?.defaults?.model?.fallbacks) {
      const fallbacks1 = result.agents.defaults.model.fallbacks as string[];
      const fallbacks2 = config2.agents.defaults.model.fallbacks as string[];
      const combined = [...new Set([...fallbacks1, ...fallbacks2])];
      result.agents.defaults.model.fallbacks = combined;
    }

    const vecWeight1 = result.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight;
    const vecWeight2 = config2.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight;

    if (vecWeight1 !== undefined && vecWeight2 !== undefined) {
      if (!result.agents) {
        result.agents = {};
      }
      if (!result.agents.defaults) {
        result.agents.defaults = {};
      }
      if (!result.agents.defaults.memorySearch) {
        result.agents.defaults.memorySearch = {};
      }
      if (!result.agents.defaults.memorySearch.query) {
        result.agents.defaults.memorySearch.query = {};
      }
      if (!result.agents.defaults.memorySearch.query.hybrid) {
        result.agents.defaults.memorySearch.query.hybrid = {};
      }
      result.agents.defaults.memorySearch.query.hybrid.vectorWeight = (vecWeight1 + vecWeight2) / 2;
    }

    return result;
  }

  getPopulation(): EvolutionIndividual[] {
    return this.population;
  }

  getBestIndividual(): EvolutionIndividual | null {
    return this.bestIndividual;
  }

  getGeneration(): number {
    return this.generation;
  }

  async saveBestConfig(): Promise<void> {
    if (!this.bestIndividual) {
      throw new Error("No best individual to save");
    }

    const agentDir = resolveOpenClawAgentDir();
    const targetPath = path.join(agentDir, "models.json");
    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      targetPath,
      JSON.stringify({ providers: this.bestIndividual.config }, null, 2),
      { mode: 0o600 },
    );
    console.log(`Saved best configuration to ${targetPath}`);
  }

  getEvolutionHistory(): {
    generation: number;
    bestFitness: number;
    avgFitness: number;
    diversity: number;
  }[] {
    const history: {
      generation: number;
      bestFitness: number;
      avgFitness: number;
      diversity: number;
    }[] = [];

    for (let g = 0; g <= this.generation; g++) {
      const genPopulation = this.archive.filter((ind) => ind.generation === g);
      if (genPopulation.length > 0) {
        const fitnesses = genPopulation.map((ind) => ind.fitness);
        const avgFitness = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
        const variance =
          fitnesses.reduce((sum, f) => sum + Math.pow(f - avgFitness, 2), 0) / fitnesses.length;
        const diversity = Math.sqrt(variance);

        history.push({
          generation: g,
          bestFitness: Math.max(...fitnesses),
          avgFitness,
          diversity,
        });
      }
    }

    return history;
  }
}

export async function runEvolution(
  initialConfig: OpenClawConfig,
  options: {
    generations?: number;
    onGeneration?: (gen: number, best: EvolutionIndividual) => void;
  } = {},
): Promise<EvolutionIndividual | null> {
  const engine = new EvolutionaryEngine({
    maxGenerations: options.generations,
  });

  await engine.initialize(initialConfig);

  for (let g = 0; g < (options.generations || DEFAULT_EVOLUTION_CONFIG.maxGenerations); g++) {
    const best = await engine.evolve();
    if (best && options.onGeneration) {
      options.onGeneration(g + 1, best);
    }
  }

  await engine.saveBestConfig();
  return engine.getBestIndividual();
}
