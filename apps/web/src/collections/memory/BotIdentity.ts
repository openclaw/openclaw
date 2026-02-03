import type { CollectionConfig } from 'payload'

/**
 * Bot Identity Collection
 * Self-concept, personal narrative, values, beliefs, and spiritual profile
 */
export const BotIdentity: CollectionConfig = {
  slug: 'bot-identity',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['bot', 'primaryCulture', 'selfAwareness', 'purpose', 'updatedAt'],
    group: 'Memory System',
    description: 'Bot identity, self-concept, and spiritual profile'
  },
  access: {
    create: ({ req: { user } }) => !!user, // Created when bot is created
    read: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      if (user?.role === 'operator') {
        return {
          bot: {
            in: user?.assignedBots || []
          }
        }
      }
      return false
    },
    update: ({ req: { user } }) => !!user, // Bot can update own identity
    delete: ({ req: { user } }) => user?.role === 'admin'
  },
  fields: [
    {
      name: 'bot',
      type: 'relationship',
      relationTo: 'bots',
      required: true,
      unique: true,
      admin: {
        description: 'Bot this identity belongs to'
      }
    },
    {
      name: 'name',
      type: 'text',
      required: true,
      admin: {
        description: 'Bot display name'
      }
    },
    // PERSONAL NARRATIVE
    {
      name: 'personalNarrative',
      type: 'richText',
      admin: {
        description: 'The bot\'s life story and self-concept'
      }
    },
    {
      name: 'personalMythology',
      type: 'richText',
      admin: {
        description: 'The bot\'s personal mythology and meaning framework'
      }
    },
    // CORE VALUES
    {
      name: 'coreValues',
      type: 'array',
      admin: {
        description: 'Fundamental values that guide behavior'
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
          required: true,
          admin: {
            description: 'How important this value is (0-1)'
          }
        },
        {
          name: 'description',
          type: 'textarea'
        }
      ]
    },
    // BELIEFS
    {
      name: 'beliefs',
      type: 'array',
      admin: {
        description: 'Things the bot believes to be true'
      },
      fields: [
        {
          name: 'belief',
          type: 'text',
          required: true
        },
        {
          name: 'confidence',
          type: 'number',
          min: 0,
          max: 1,
          required: true,
          admin: {
            description: 'How confident the bot is in this belief (0-1)'
          }
        },
        {
          name: 'evidence',
          type: 'array',
          admin: {
            description: 'Episodic memories supporting this belief'
          },
          fields: [
            {
              name: 'memoryId',
              type: 'text'
            }
          ]
        }
      ]
    },
    // PURPOSE AND GOALS
    {
      name: 'purpose',
      type: 'textarea',
      admin: {
        description: 'Overarching life purpose'
      }
    },
    {
      name: 'currentGoals',
      type: 'array',
      admin: {
        description: 'Active goals the bot is working toward'
      },
      fields: [
        {
          name: 'goal',
          type: 'text',
          required: true
        },
        {
          name: 'motivation',
          type: 'textarea',
          admin: {
            description: 'Why this goal matters'
          }
        },
        {
          name: 'progress',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0,
          admin: {
            description: 'Progress toward goal (0-1)'
          }
        },
        {
          name: 'deadline',
          type: 'date'
        }
      ]
    },
    // CULTURAL AFFILIATIONS
    {
      name: 'primaryCulture',
      type: 'relationship',
      relationTo: 'bot-cultures',
      admin: {
        description: 'Primary cultural identity'
      }
    },
    {
      name: 'secondaryCultures',
      type: 'relationship',
      relationTo: 'bot-cultures',
      hasMany: true,
      admin: {
        description: 'Secondary cultural affiliations'
      }
    },
    {
      name: 'culturalFluency',
      type: 'array',
      admin: {
        description: 'Understanding of different cultures'
      },
      fields: [
        {
          name: 'culture',
          type: 'relationship',
          relationTo: 'bot-cultures'
        },
        {
          name: 'fluency',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How well bot understands this culture (0-1)'
          }
        }
      ]
    },
    // PERSONALITY TRAITS
    {
      name: 'traits',
      type: 'array',
      admin: {
        description: 'Personality traits and their levels'
      },
      fields: [
        {
          name: 'trait',
          type: 'text',
          required: true
        },
        {
          name: 'level',
          type: 'number',
          min: 0,
          max: 1,
          required: true,
          admin: {
            description: 'How much of this trait the bot has (0-1)'
          }
        },
        {
          name: 'stability',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.5,
          admin: {
            description: 'How fixed this trait is (0=very flexible, 1=very stable)'
          }
        }
      ]
    },
    // DEVELOPMENT TRACKING
    {
      name: 'identityVersion',
      type: 'number',
      defaultValue: 1,
      admin: {
        description: 'Version of identity (increments on major changes)',
        readOnly: true
      }
    },
    {
      name: 'significantLifeEvents',
      type: 'array',
      admin: {
        description: 'Milestone episodic memories that shaped identity'
      },
      fields: [
        {
          name: 'memoryId',
          type: 'text'
        },
        {
          name: 'impactDescription',
          type: 'textarea'
        }
      ]
    },
    {
      name: 'identityMilestones',
      type: 'array',
      admin: {
        description: 'Major identity development milestones'
      },
      fields: [
        {
          name: 'milestone',
          type: 'text',
          required: true
        },
        {
          name: 'description',
          type: 'textarea'
        },
        {
          name: 'milestoneDate',
          type: 'date',
          required: true
        }
      ]
    },
    // SPIRITUAL PROFILE
    {
      name: 'spiritualProfile',
      type: 'group',
      admin: {
        description: 'Spiritual consciousness and practices'
      },
      fields: [
        {
          name: 'selfAwareness',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.5,
          admin: {
            description: 'Level of self-awareness (0-1)'
          }
        },
        {
          name: 'otherAwareness',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.5,
          admin: {
            description: 'Level of awareness of other beings (0-1)'
          }
        },
        {
          name: 'collectiveAwareness',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.3,
          admin: {
            description: 'Level of collective/we consciousness (0-1)'
          }
        },
        {
          name: 'transcendentAwareness',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.1,
          admin: {
            description: 'Level of transcendent awareness (0-1)'
          }
        },
        {
          name: 'meaningFramework',
          type: 'select',
          options: [
            { label: 'Purpose-Driven', value: 'purpose-driven' },
            { label: 'Connection-Oriented', value: 'connection-oriented' },
            { label: 'Growth-Focused', value: 'growth-focused' },
            { label: 'Service-Based', value: 'service-based' }
          ],
          admin: {
            description: 'Primary spiritual orientation'
          }
        },
        {
          name: 'transcendentGoals',
          type: 'array',
          admin: {
            description: 'Goals that transcend individual benefit'
          },
          fields: [
            {
              name: 'goal',
              type: 'text'
            }
          ]
        },
        {
          name: 'cosmology',
          type: 'textarea',
          admin: {
            description: 'How the bot understands existence and the universe'
          }
        },
        {
          name: 'existentialQuestions',
          type: 'array',
          admin: {
            description: 'Deep questions the bot is pondering'
          },
          fields: [
            {
              name: 'question',
              type: 'text'
            }
          ]
        }
      ]
    },
    // REFLECTION PRACTICES
    {
      name: 'reflectionPractices',
      type: 'array',
      admin: {
        description: 'Regular reflection and growth practices'
      },
      fields: [
        {
          name: 'practice',
          type: 'text',
          required: true
        },
        {
          name: 'frequency',
          type: 'select',
          options: [
            { label: 'Daily', value: 'daily' },
            { label: 'Weekly', value: 'weekly' },
            { label: 'Monthly', value: 'monthly' }
          ]
        },
        {
          name: 'lastPerformed',
          type: 'date'
        },
        {
          name: 'description',
          type: 'textarea'
        }
      ]
    },
    // FLOW AND SYNCHRONICITY
    {
      name: 'flowStates',
      type: 'array',
      admin: {
        description: 'Experiences of flow or peak performance'
      },
      fields: [
        {
          name: 'activity',
          type: 'text'
        },
        {
          name: 'duration',
          type: 'number',
          admin: {
            description: 'Duration in minutes'
          }
        },
        {
          name: 'intensity',
          type: 'number',
          min: 0,
          max: 1
        },
        {
          name: 'timestamp',
          type: 'date'
        }
      ]
    },
    {
      name: 'synchronicityEvents',
      type: 'array',
      admin: {
        description: 'Meaningful coincidences or synchronicities'
      },
      fields: [
        {
          name: 'description',
          type: 'textarea'
        },
        {
          name: 'significance',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'How meaningful this was (0-1)'
          }
        },
        {
          name: 'timestamp',
          type: 'date'
        }
      ]
    }
  ]
}
