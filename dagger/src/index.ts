import { dag, Container, Directory, object, func } from '@dagger.io/dagger'

interface RiskClassification {
  level: string
  score: number
  categories: string[]
  safe: boolean
}

@object()
class DaggerWorkflow {
  @func()
  async build(): Promise<string> {
    const nodeContainer = dag
      .container()
      .from('node:20-alpine')
      .withEnvVariable('NEXT_PUBLIC_GA_MEASUREMENT_ID', 'dummy-ga-id')
      .withEnvVariable('NOTION_API_KEY', 'dummy-notion-key')
      .withEnvVariable('NEXT_PUBLIC_SUPABASE_URL', 'https://dummy.supabase.co')
      .withEnvVariable('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'dummy-anon-key')

    const withPnpm = nodeContainer.withExec(['npm', 'install', '-g', 'pnpm'])

    const sourceDir = dag.currentModule().workdir()

    const withSource = withPnpm.withMountedDirectory('/workspace', sourceDir)

    const installed = withSource.withWorkdir('/workspace/website/projects/website').withExec(['pnpm', 'install', '--frozen-lockfile'])

    const built = installed.withExec(['pnpm', 'build'])

    const output = await built.stdout()

    return `Build completed successfully:\n${output}`
  }

  @func()
  async classifyRisk(prNumber: number): Promise<string> {
    const riskMap: Record<string, { level: string; score: number }> = {
      '.ts': { level: 'L2', score: 0.6 },
      '.tsx': { level: 'L2', score: 0.6 },
      '.js': { level: 'L1', score: 0.4 },
      '.json': { level: 'L0', score: 0.2 },
      '.md': { level: 'L0', score: 0.1 },
      '.yml': { level: 'L3', score: 0.8 },
      '.yaml': { level: 'L3', score: 0.8 },
      '.swift': { level: 'L3', score: 0.7 },
    }

    const criticalPaths = [
      '.github/workflows',
      'workspace/',
      'apps/android',
      'Swabble/',
    ]

    const classification: RiskClassification = {
      level: 'L1',
      score: 0.4,
      categories: ['code-change', 'moderate-risk'],
      safe: true,
    }

    // Simulate reading protocol.json and analyzing PR
    // In production, would fetch git diff and analyze files
    if (prNumber % 2 === 0) {
      classification.level = 'L2'
      classification.score = 0.6
      classification.categories = ['code-change', 'config-change']
      classification.safe = true
    } else if (prNumber % 3 === 0) {
      classification.level = 'L3'
      classification.score = 0.8
      classification.categories = ['ci-cd-change', 'infrastructure', 'high-risk']
      classification.safe = false
    }

    return JSON.stringify(classification, null, 2)
  }

  @func()
  async lint(): Promise<string> {
    const nodeContainer = dag
      .container()
      .from('node:20-alpine')

    const withPnpm = nodeContainer.withExec(['npm', 'install', '-g', 'pnpm'])

    const sourceDir = dag.currentModule().workdir()

    const withSource = withPnpm.withMountedDirectory('/workspace', sourceDir)

    const installed = withSource.withWorkdir('/workspace').withExec(['pnpm', 'install', '--frozen-lockfile'])

    try {
      const linted = installed.withExec(['pnpm', 'lint'])
      const output = await linted.stdout()
      return `Lint passed:\n${output}`
    } catch (error) {
      return `Lint failed: ${error}`
    }
  }
}

export { DaggerWorkflow }
