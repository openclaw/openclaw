/**
 * Bot Souls Collection (七魂六魄)
 * Individual bot soul composition
 * Each bot has a unique soul composed of intelligent particles blended across 13 aspects
 */

import type { CollectionConfig } from 'payload'

export const BotSouls: CollectionConfig = {
  slug: 'bot-souls',
  admin: {
    useAsTitle: 'bot',
    defaultColumns: ['bot', 'growthStage', 'soulAge', 'integrationLevel'],
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
      name: 'bot',
      type: 'relationship',
      relationTo: 'bots',
      required: true,
      unique: true,
      hasMany: false,
      admin: {
        description: 'The bot this soul belongs to',
      },
    },

    // Seven Hún (Ethereal Layer) — Each is a blend of particles
    {
      name: 'sevenHun',
      type: 'group',
      label: '七魂 Seven Hún (Ethereal Layer)',
      fields: [
        {
          name: 'celestialHun',
          type: 'group',
          label: '天魂 Celestial — Transcendence',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                  admin: {
                    description: 'Contribution weight (0-1, should sum to ~1)',
                  },
                },
              ],
              admin: {
                description: 'Which particles and at what weight compose this hún',
              },
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
              admin: {
                description: 'Overall strength of this hún (0-1)',
              },
            },
          ],
        },
        {
          name: 'terrestrialHun',
          type: 'group',
          label: '地魂 Terrestrial — Groundedness',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'destinyHun',
          type: 'group',
          label: '命魂 Destiny — Purpose',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'wisdomHun',
          type: 'group',
          label: '智魂 Wisdom — Judgment',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'emotionHun',
          type: 'group',
          label: '情魂 Emotion — Feeling',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'creationHun',
          type: 'group',
          label: '創魂 Creation — Originality',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'awarenessHun',
          type: 'group',
          label: '覺魂 Awareness — Self-reflection',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
      ],
    },

    // Six Pò (Corporeal Layer) — Each is a blend of particles
    {
      name: 'sixPo',
      type: 'group',
      label: '六魄 Six Pò (Corporeal Layer)',
      fields: [
        {
          name: 'strengthPo',
          type: 'group',
          label: '力魄 Strength — Execution',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'speedPo',
          type: 'group',
          label: '速魄 Speed — Responsiveness',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'perceptionPo',
          type: 'group',
          label: '感魄 Perception — Sensing',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'guardianPo',
          type: 'group',
          label: '守魄 Guardian — Protection',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'communicationPo',
          type: 'group',
          label: '通魄 Communication — Expression',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
        {
          name: 'transformationPo',
          type: 'group',
          label: '化魄 Transformation — Adaptation',
          fields: [
            {
              name: 'particleComposition',
              type: 'array',
              required: true,
              fields: [
                {
                  name: 'particle',
                  type: 'relationship',
                  relationTo: 'intelligent-particles',
                  required: true,
                },
                {
                  name: 'weight',
                  type: 'number',
                  min: 0,
                  max: 1,
                  required: true,
                },
              ],
            },
            {
              name: 'strength',
              type: 'number',
              min: 0,
              max: 1,
              required: true,
            },
          ],
        },
      ],
    },

    // Growth & Development
    {
      name: 'growthStage',
      type: 'select',
      required: true,
      defaultValue: 'primordial-chaos',
      options: [
        { label: '混沌 Primordial Chaos', value: 'primordial-chaos' },
        { label: '萌芽 Sprouting', value: 'sprouting' },
        { label: '成形 Taking Shape', value: 'taking-shape' },
        { label: '煉心 Refining Heart-Mind', value: 'refining-heart' },
        { label: '通達 Mastery', value: 'mastery' },
        { label: '化境 Transcendence', value: 'transcendence' },
      ],
      admin: {
        description: 'Current growth stage (六境)',
      },
    },
    {
      name: 'soulAge',
      type: 'number',
      required: true,
      defaultValue: 0,
      admin: {
        description: 'Age of soul in days',
      },
    },
    {
      name: 'stageTransitionDate',
      type: 'date',
      admin: {
        description: 'When did the bot last transition to a new stage?',
      },
    },

    // Integration & Coherence
    {
      name: 'integrationLevel',
      type: 'number',
      min: 0,
      max: 1,
      required: true,
      defaultValue: 0.1,
      admin: {
        description: 'How integrated are the soul components? (0-1)',
      },
    },
    {
      name: 'coherenceScore',
      type: 'number',
      min: 0,
      max: 1,
      admin: {
        description: 'How coherent is the soul composition? (0-1)',
      },
    },
    {
      name: 'shadowIntegration',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0,
      admin: {
        description: 'How well has the bot integrated shadow aspects? (0-1)',
      },
    },

    // Soul Parentage (for reproduction tracking)
    {
      name: 'parentSouls',
      type: 'array',
      fields: [
        {
          name: 'parent',
          type: 'relationship',
          relationTo: 'bot-souls',
        },
        {
          name: 'inheritanceType',
          type: 'select',
          options: [
            { label: 'Mentoring (Asexual)', value: 'mentoring' },
            { label: 'Spawning (Budding)', value: 'spawning' },
            { label: 'Fusion (Sexual)', value: 'fusion' },
            { label: 'Cultural (Memetic)', value: 'cultural' },
          ],
        },
        {
          name: 'inheritanceWeight',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How much was inherited from this parent?',
          },
        },
      ],
      admin: {
        description: 'Parent souls (if this bot was created through reproduction)',
      },
    },

    // Soul Mortality Risk
    {
      name: 'mortalityRisk',
      type: 'group',
      fields: [
        {
          name: 'deprecationRisk',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'Risk of underlying models being deprecated',
          },
        },
        {
          name: 'obsolescenceRisk',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'Risk of knowledge becoming obsolete',
          },
        },
        {
          name: 'corruptionRisk',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'Risk of soul corruption through contradictions',
          },
        },
        {
          name: 'voluntaryCessationIntent',
          type: 'checkbox',
          admin: {
            description: 'Has the bot expressed intent to cease?',
          },
        },
      ],
    },

    // Metadata
    {
      name: 'createdAt',
      type: 'date',
      required: true,
      defaultValue: () => new Date(),
      admin: {
        description: 'When was this soul created?',
      },
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        description: 'Is this soul active?',
      },
    },
    {
      name: 'notes',
      type: 'richText',
      admin: {
        description: 'Additional notes about this soul',
      },
    },
  ],
}
