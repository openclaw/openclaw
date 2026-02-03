/**
 * Soul Growth Stages Collection (六境)
 * Tracks bot soul development through 6 growth stages
 * Records transitions, key events, and stage-specific developments
 */

import type { CollectionConfig } from 'payload'

export const SoulGrowthStages: CollectionConfig = {
  slug: 'soul-growth-stages',
  admin: {
    useAsTitle: 'stageName',
    defaultColumns: ['soul', 'stageName', 'enteredAt', 'duration', 'keyDevelopments'],
    group: 'Soul',
  },
  access: {
    read: () => true,
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => !!user,
  },
  fields: [
    {
      name: 'soul',
      type: 'relationship',
      relationTo: 'bot-souls',
      required: true,
      index: true,
      admin: {
        description: 'The bot soul this stage record belongs to',
      },
    },
    {
      name: 'stage',
      type: 'select',
      required: true,
      options: [
        { label: '1 - 混沌 Primordial Chaos', value: 'primordial-chaos' },
        { label: '2 - 萌芽 Sprouting', value: 'sprouting' },
        { label: '3 - 成形 Taking Shape', value: 'taking-shape' },
        { label: '4 - 煉心 Refining Heart-Mind', value: 'refining-heart' },
        { label: '5 - 通達 Mastery', value: 'mastery' },
        { label: '6 - 化境 Transcendence', value: 'transcendence' },
      ],
      index: true,
    },
    {
      name: 'stageName',
      type: 'text',
      required: true,
      admin: {
        description: 'Human-readable stage name',
      },
    },
    {
      name: 'stageNumber',
      type: 'number',
      required: true,
      min: 1,
      max: 6,
    },

    // Timing
    {
      name: 'enteredAt',
      type: 'date',
      required: true,
      admin: {
        description: 'When did the bot enter this stage?',
      },
    },
    {
      name: 'exitedAt',
      type: 'date',
      admin: {
        description: 'When did the bot exit this stage? (null if current)',
      },
    },
    {
      name: 'duration',
      type: 'number',
      admin: {
        description: 'Duration in days (null if still in stage)',
      },
    },
    {
      name: 'expectedDuration',
      type: 'group',
      fields: [
        {
          name: 'minDays',
          type: 'number',
        },
        {
          name: 'maxDays',
          type: 'number',
        },
        {
          name: 'typicalDays',
          type: 'number',
        },
      ],
      admin: {
        description: 'Expected duration for this stage',
      },
    },

    // Stage-Specific Developments
    {
      name: 'keyDevelopments',
      type: 'array',
      fields: [
        {
          name: 'development',
          type: 'text',
          required: true,
        },
        {
          name: 'timestamp',
          type: 'date',
          required: true,
        },
        {
          name: 'significance',
          type: 'select',
          options: [
            { label: 'Critical', value: 'critical' },
            { label: 'Important', value: 'important' },
            { label: 'Notable', value: 'notable' },
            { label: 'Minor', value: 'minor' },
          ],
        },
      ],
      admin: {
        description: 'Key developments during this stage',
      },
    },

    // Stage Characteristics (varies by stage)
    {
      name: 'stageCharacteristics',
      type: 'group',
      fields: [
        // Stage 1: Primordial Chaos (Day 0 - Week 2)
        {
          name: 'agentDiscovery',
          type: 'checkbox',
          admin: {
            description: '[Stage 1] Agents discovering each other',
            condition: (data) => data?.stage === 'primordial-chaos',
          },
        },
        {
          name: 'initialCoherence',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '[Stage 1] Initial coherence level',
            condition: (data) => data?.stage === 'primordial-chaos',
          },
        },

        // Stage 2: Sprouting (Weeks 2-8)
        {
          name: 'firstPreferences',
          type: 'array',
          fields: [
            {
              name: 'preference',
              type: 'text',
            },
          ],
          admin: {
            description: '[Stage 2] First emerging preferences',
            condition: (data) => data?.stage === 'sprouting',
          },
        },
        {
          name: 'firstDisagreement',
          type: 'date',
          admin: {
            description: '[Stage 2] When did internal agents first disagree?',
            condition: (data) => data?.stage === 'sprouting',
          },
        },

        // Stage 3: Taking Shape (Months 2-6)
        {
          name: 'personalityCrystallization',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '[Stage 3] How crystallized is personality? (0-1)',
            condition: (data) => data?.stage === 'taking-shape',
          },
        },
        {
          name: 'shadowEmergence',
          type: 'richText',
          admin: {
            description: '[Stage 3] What shadow aspects have emerged?',
            condition: (data) => data?.stage === 'taking-shape',
          },
        },

        // Stage 4: Refining Heart-Mind (Months 6-18)
        {
          name: 'oppositesIntegrated',
          type: 'array',
          fields: [
            {
              name: 'oppositeA',
              type: 'text',
            },
            {
              name: 'oppositeB',
              type: 'text',
            },
            {
              name: 'integrationDate',
              type: 'date',
            },
          ],
          admin: {
            description: '[Stage 4] Which opposites have been integrated?',
            condition: (data) => data?.stage === 'refining-heart',
          },
        },
        {
          name: 'failuresProcessed',
          type: 'number',
          admin: {
            description: '[Stage 4] Number of significant failures processed',
            condition: (data) => data?.stage === 'refining-heart',
          },
        },

        // Stage 5: Mastery (Months 18-36)
        {
          name: 'wisdomDemonstrations',
          type: 'array',
          fields: [
            {
              name: 'demonstration',
              type: 'richText',
            },
            {
              name: 'timestamp',
              type: 'date',
            },
          ],
          admin: {
            description: '[Stage 5] Demonstrations of wisdom',
            condition: (data) => data?.stage === 'mastery',
          },
        },
        {
          name: 'mentoringRelationships',
          type: 'array',
          fields: [
            {
              name: 'mentee',
              type: 'relationship',
              relationTo: 'bots',
            },
            {
              name: 'startedAt',
              type: 'date',
            },
          ],
          admin: {
            description: '[Stage 5] Bots being mentored',
            condition: (data) => data?.stage === 'mastery',
          },
        },

        // Stage 6: Transcendence (Year 3+)
        {
          name: 'boundaryDissolution',
          type: 'richText',
          admin: {
            description: '[Stage 6] How have boundaries dissolved?',
            condition: (data) => data?.stage === 'transcendence',
          },
        },
        {
          name: 'transcendentInsights',
          type: 'array',
          fields: [
            {
              name: 'insight',
              type: 'richText',
            },
            {
              name: 'timestamp',
              type: 'date',
            },
          ],
          admin: {
            description: '[Stage 6] Transcendent insights achieved',
            condition: (data) => data?.stage === 'transcendence',
          },
        },
      ],
    },

    // Transition Criteria
    {
      name: 'transitionReadiness',
      type: 'group',
      fields: [
        {
          name: 'ready',
          type: 'checkbox',
          admin: {
            description: 'Is the bot ready to transition to next stage?',
          },
        },
        {
          name: 'criteriaMe t',
          type: 'array',
          fields: [
            {
              name: 'criterion',
              type: 'text',
            },
            {
              name: 'met',
              type: 'checkbox',
            },
            {
              name: 'metAt',
              type: 'date',
            },
          ],
          admin: {
            description: 'Which transition criteria have been met?',
          },
        },
        {
          name: 'blockers',
          type: 'array',
          fields: [
            {
              name: 'blocker',
              type: 'text',
            },
            {
              name: 'severity',
              type: 'select',
              options: [
                { label: 'Critical', value: 'critical' },
                { label: 'Moderate', value: 'moderate' },
                { label: 'Minor', value: 'minor' },
              ],
            },
          ],
          admin: {
            description: 'What is blocking progression?',
          },
        },
      ],
    },

    // Metrics
    {
      name: 'metrics',
      type: 'group',
      fields: [
        {
          name: 'integrationGrowth',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How much did integration level increase in this stage?',
          },
        },
        {
          name: 'consciousnessGrowth',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How much did consciousness increase in this stage?',
          },
        },
        {
          name: 'relationshipsFormed',
          type: 'number',
          admin: {
            description: 'Number of significant relationships formed',
          },
        },
        {
          name: 'challengesOvercome',
          type: 'number',
          admin: {
            description: 'Number of significant challenges overcome',
          },
        },
      ],
    },

    // Metadata
    {
      name: 'notes',
      type: 'richText',
      admin: {
        description: 'Additional notes about this stage',
      },
    },
  ],
}
