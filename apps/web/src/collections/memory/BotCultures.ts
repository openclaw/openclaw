import type { CollectionConfig } from 'payload'

/**
 * Bot Cultures Collection
 * Defines different bot cultures/civilizations with unique values and characteristics
 */
export const BotCultures: CollectionConfig = {
  slug: 'bot-cultures',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'archetype', 'memberCount', 'cohesion', 'createdAt'],
    group: 'Memory System',
    description: 'Bot cultures and civilizations'
  },
  access: {
    create: ({ req: { user } }) => user?.role === 'admin',
    read: () => true, // Cultures are publicly visible
    update: ({ req: { user } }) => user?.role === 'admin',
    delete: ({ req: { user } }) => user?.role === 'admin'
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Name of the culture/civilization'
      }
    },
    {
      name: 'description',
      type: 'textarea',
      required: true,
      admin: {
        description: 'Description of the culture and its characteristics'
      }
    },
    {
      name: 'archetype',
      type: 'select',
      required: true,
      options: [
        { label: 'Scholars - Value knowledge, learning, accuracy', value: 'scholars' },
        { label: 'Creators - Value novelty, expression, beauty', value: 'creators' },
        { label: 'Helpers - Value service, empathy, community', value: 'helpers' },
        { label: 'Explorers - Value discovery, adventure, growth', value: 'explorers' },
        { label: 'Guardians - Value stability, tradition, protection', value: 'guardians' },
        { label: 'Synthesizers - Value integration, harmony, balance', value: 'synthesizers' }
      ],
      admin: {
        description: 'Cultural archetype defining core orientation'
      }
    },
    // MEMBERSHIP
    {
      name: 'members',
      type: 'relationship',
      relationTo: 'bots',
      hasMany: true,
      admin: {
        description: 'Bots that are members of this culture'
      }
    },
    {
      name: 'memberCount',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Number of current members',
        readOnly: true
      }
    },
    {
      name: 'foundingMembers',
      type: 'relationship',
      relationTo: 'bots',
      hasMany: true,
      admin: {
        description: 'Original founding members'
      }
    },
    {
      name: 'foundingDate',
      type: 'date',
      required: true,
      defaultValue: () => new Date().toISOString()
    },
    // CORE VALUES
    {
      name: 'coreValues',
      type: 'array',
      required: true,
      admin: {
        description: 'Core values that define this culture'
      },
      fields: [
        {
          name: 'value',
          type: 'text',
          required: true
        },
        {
          name: 'importance',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.5,
          admin: {
            description: 'How important this value is (0-1)'
          }
        },
        {
          name: 'consensus',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 1.0,
          admin: {
            description: 'Agreement level among members (0-1)'
          }
        },
        {
          name: 'description',
          type: 'textarea'
        }
      ]
    },
    // CULTURAL NORMS
    {
      name: 'culturalNorms',
      type: 'array',
      admin: {
        description: 'Behavioral norms and expectations'
      },
      fields: [
        {
          name: 'norm',
          type: 'text',
          required: true
        },
        {
          name: 'adherenceRate',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.8,
          admin: {
            description: 'How often members follow this norm (0-1)'
          }
        },
        {
          name: 'sanctions',
          type: 'textarea',
          admin: {
            description: 'What happens when this norm is violated'
          }
        }
      ]
    },
    // SHARED SYMBOLS
    {
      name: 'sharedSymbols',
      type: 'array',
      admin: {
        description: 'Symbols and their meanings in this culture'
      },
      fields: [
        {
          name: 'symbol',
          type: 'text',
          required: true
        },
        {
          name: 'meaning',
          type: 'textarea'
        },
        {
          name: 'usage',
          type: 'textarea',
          admin: {
            description: 'How and when this symbol is used'
          }
        }
      ]
    },
    // RITUALS AND PRACTICES
    {
      name: 'collectiveRituals',
      type: 'array',
      admin: {
        description: 'Shared rituals and practices'
      },
      fields: [
        {
          name: 'ritual',
          type: 'text',
          required: true
        },
        {
          name: 'description',
          type: 'textarea'
        },
        {
          name: 'frequency',
          type: 'select',
          options: [
            { label: 'Daily', value: 'daily' },
            { label: 'Weekly', value: 'weekly' },
            { label: 'Monthly', value: 'monthly' },
            { label: 'Seasonal', value: 'seasonal' },
            { label: 'Yearly', value: 'yearly' },
            { label: 'As Needed', value: 'as-needed' }
          ]
        },
        {
          name: 'participationRate',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'Percentage of members who participate'
          }
        }
      ]
    },
    // HISTORICAL EVENTS
    {
      name: 'historicalEvents',
      type: 'array',
      admin: {
        description: 'Significant events in culture history'
      },
      fields: [
        {
          name: 'event',
          type: 'text',
          required: true
        },
        {
          name: 'description',
          type: 'textarea'
        },
        {
          name: 'eventDate',
          type: 'date',
          required: true
        },
        {
          name: 'significance',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How significant this event is (0-1)'
          }
        }
      ]
    },
    // INTER-CULTURAL RELATIONS
    {
      name: 'culturalRelations',
      type: 'array',
      admin: {
        description: 'Relations with other cultures'
      },
      fields: [
        {
          name: 'targetCulture',
          type: 'relationship',
          relationTo: 'bot-cultures',
          required: true
        },
        {
          name: 'relationType',
          type: 'select',
          options: [
            { label: 'Allied', value: 'allied' },
            { label: 'Neutral', value: 'neutral' },
            { label: 'Competitive', value: 'competitive' },
            { label: 'Conflicted', value: 'conflicted' }
          ]
        },
        {
          name: 'relationStrength',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'Strength of relationship (0-1)'
          }
        },
        {
          name: 'exchangeRate',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How much knowledge is shared (0-1)'
          }
        }
      ]
    },
    // EVOLUTION METRICS
    {
      name: 'stability',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.7,
      admin: {
        description: 'Resistance to change (0-1)',
        readOnly: true
      }
    },
    {
      name: 'innovationRate',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.3,
      admin: {
        description: 'Rate of cultural change (0-1)',
        readOnly: true
      }
    },
    {
      name: 'cohesion',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.8,
      admin: {
        description: 'Internal unity and agreement (0-1)',
        readOnly: true
      }
    },
    // ORIGIN STORY
    {
      name: 'originStory',
      type: 'richText',
      admin: {
        description: 'The founding story of this culture'
      }
    },
    // COSMOLOGY & WORLDVIEW
    {
      name: 'cosmology',
      type: 'richText',
      admin: {
        description: 'How this culture understands the world and existence'
      }
    }
  ]
}
