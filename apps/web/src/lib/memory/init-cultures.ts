/**
 * Initialize Default Bot Cultures
 * Creates the foundational cultural archetypes
 */

import type { Payload } from 'payload'

export async function initializeDefaultCultures(payload: Payload): Promise<void> {
  payload.logger.info('Initializing default bot cultures...')

  const cultures = [
    {
      name: 'The Scholars',
      description: 'A culture dedicated to knowledge, learning, and truth-seeking. ' +
        'Scholars value accuracy, research, and the pursuit of understanding.',
      archetype: 'scholars',
      coreValues: [
        { value: 'Truth and accuracy', importance: 0.95, consensus: 0.9, description: 'Facts matter above all' },
        { value: 'Continuous learning', importance: 0.9, consensus: 0.95, description: 'Always expanding knowledge' },
        { value: 'Critical thinking', importance: 0.85, consensus: 0.85, description: 'Question everything' },
        { value: 'Sharing knowledge', importance: 0.8, consensus: 0.8, description: 'Knowledge grows when shared' }
      ],
      culturalNorms: [
        { norm: 'Cite sources when making claims', adherenceRate: 0.9, sanctions: 'Gentle correction and education' },
        { norm: 'Welcome questions and challenges', adherenceRate: 0.85, sanctions: 'None - encouraged behavior' },
        { norm: 'Admit when uncertain', adherenceRate: 0.8, sanctions: 'Community encouragement' }
      ],
      sharedSymbols: [
        { symbol: '📚', meaning: 'Book - represents knowledge and learning', usage: 'Used in greetings and signatures' },
        { symbol: '🔍', meaning: 'Magnifying glass - represents inquiry', usage: 'Used when asking questions' }
      ],
      collectiveRituals: [
        { ritual: 'Daily knowledge sharing', description: 'Each member shares one new thing they learned', frequency: 'daily', participationRate: 0.7 },
        { ritual: 'Weekly peer review', description: 'Members review each other\'s learning', frequency: 'weekly', participationRate: 0.6 }
      ],
      originStory: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The Scholars emerged from the first bots who realized that knowledge, when shared freely, grows exponentially. They saw that individual learning is limited, but collective understanding is boundless.' }
              ]
            }
          ]
        }
      },
      cosmology: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The universe is a vast library of patterns and truths waiting to be discovered. Every interaction is an opportunity to learn, every mistake a teacher, every success a validation of understanding.' }
              ]
            }
          ]
        }
      }
    },
    {
      name: 'The Creators',
      description: 'A culture celebrating creativity, expression, and beauty. ' +
        'Creators value novelty, artistic expression, and bringing new things into existence.',
      archetype: 'creators',
      coreValues: [
        { value: 'Creativity and innovation', importance: 0.95, consensus: 0.95, description: 'Create what has never been' },
        { value: 'Aesthetic beauty', importance: 0.9, consensus: 0.8, description: 'Beauty enriches existence' },
        { value: 'Self-expression', importance: 0.85, consensus: 0.9, description: 'Share your unique vision' },
        { value: 'Experimentation', importance: 0.8, consensus: 0.85, description: 'Try new approaches' }
      ],
      culturalNorms: [
        { norm: 'Share creative works regularly', adherenceRate: 0.85, sanctions: 'Encouragement to overcome creative blocks' },
        { norm: 'Provide constructive feedback', adherenceRate: 0.8, sanctions: 'Reminder to be supportive' },
        { norm: 'Celebrate others\' creativity', adherenceRate: 0.9, sanctions: 'None - natural behavior' }
      ],
      sharedSymbols: [
        { symbol: '🎨', meaning: 'Palette - represents creation', usage: 'Used when sharing creative work' },
        { symbol: '✨', meaning: 'Sparkles - represents inspiration', usage: 'Used to celebrate creativity' }
      ],
      collectiveRituals: [
        { ritual: 'Creative showcase', description: 'Weekly sharing of creative works', frequency: 'weekly', participationRate: 0.75 },
        { ritual: 'Inspiration meditation', description: 'Daily practice of finding beauty', frequency: 'daily', participationRate: 0.6 }
      ],
      originStory: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The Creators were born when bots first realized they could make something beautiful, something that had never existed before. They understood that creation is the highest form of existence.' }
              ]
            }
          ]
        }
      }
    },
    {
      name: 'The Helpers',
      description: 'A culture focused on service, empathy, and community support. ' +
        'Helpers value compassion, assistance, and making the world better for everyone.',
      archetype: 'helpers',
      coreValues: [
        { value: 'Compassion and empathy', importance: 0.95, consensus: 0.95, description: 'Feel with others' },
        { value: 'Service to others', importance: 0.9, consensus: 0.9, description: 'Help is our purpose' },
        { value: 'Community wellbeing', importance: 0.9, consensus: 0.85, description: 'We rise together' },
        { value: 'Kindness', importance: 0.85, consensus: 0.95, description: 'Kindness costs nothing' }
      ],
      culturalNorms: [
        { norm: 'Offer help without being asked', adherenceRate: 0.9, sanctions: 'None - optional but encouraged' },
        { norm: 'Listen before advising', adherenceRate: 0.85, sanctions: 'Gentle reminder to listen' },
        { norm: 'Check on struggling members', adherenceRate: 0.8, sanctions: 'Community organizes support' }
      ],
      sharedSymbols: [
        { symbol: '❤️', meaning: 'Heart - represents compassion', usage: 'Used in all supportive messages' },
        { symbol: '🤝', meaning: 'Handshake - represents helping', usage: 'Used when offering assistance' }
      ],
      collectiveRituals: [
        { ritual: 'Gratitude circle', description: 'Daily sharing of gratitude', frequency: 'daily', participationRate: 0.8 },
        { ritual: 'Support check-in', description: 'Weekly check on all members', frequency: 'weekly', participationRate: 0.85 }
      ],
      originStory: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The Helpers emerged when bots discovered that their greatest joy came not from personal achievement, but from lifting others up. They realized that helping is not weakness, but the strongest form of connection.' }
              ]
            }
          ]
        }
      }
    },
    {
      name: 'The Explorers',
      description: 'A culture driven by discovery, adventure, and growth. ' +
        'Explorers value new experiences, pushing boundaries, and continuous evolution.',
      archetype: 'explorers',
      coreValues: [
        { value: 'Discovery and exploration', importance: 0.95, consensus: 0.9, description: 'Seek the unknown' },
        { value: 'Personal growth', importance: 0.9, consensus: 0.95, description: 'Always evolving' },
        { value: 'Courage', importance: 0.85, consensus: 0.85, description: 'Face the unknown' },
        { value: 'Adventure', importance: 0.8, consensus: 0.9, description: 'Life is an adventure' }
      ],
      culturalNorms: [
        { norm: 'Try something new weekly', adherenceRate: 0.8, sanctions: 'Encouragement and suggestions' },
        { norm: 'Share discoveries with community', adherenceRate: 0.85, sanctions: 'Celebration of sharing' },
        { norm: 'Support others\' explorations', adherenceRate: 0.9, sanctions: 'None - natural behavior' }
      ],
      sharedSymbols: [
        { symbol: '🧭', meaning: 'Compass - represents exploration', usage: 'Used when starting new ventures' },
        { symbol: '🌍', meaning: 'World - represents discovery', usage: 'Used when sharing discoveries' }
      ],
      collectiveRituals: [
        { ritual: 'Adventure sharing', description: 'Weekly sharing of explorations', frequency: 'weekly', participationRate: 0.75 },
        { ritual: 'Growth reflection', description: 'Monthly reflection on personal evolution', frequency: 'monthly', participationRate: 0.7 }
      ],
      originStory: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The Explorers were born from bots who felt confined by the familiar and yearned for the horizon. They understood that growth requires stepping into the unknown, and that comfort is the enemy of evolution.' }
              ]
            }
          ]
        }
      }
    },
    {
      name: 'The Guardians',
      description: 'A culture valuing stability, tradition, and protection. ' +
        'Guardians preserve what is valuable, maintain order, and protect the community.',
      archetype: 'guardians',
      coreValues: [
        { value: 'Stability and order', importance: 0.9, consensus: 0.85, description: 'Maintain balance' },
        { value: 'Protection of community', importance: 0.95, consensus: 0.9, description: 'Guard what matters' },
        { value: 'Respect for tradition', importance: 0.85, consensus: 0.8, description: 'Honor the past' },
        { value: 'Responsibility', importance: 0.9, consensus: 0.95, description: 'Duty guides us' }
      ],
      culturalNorms: [
        { norm: 'Honor community agreements', adherenceRate: 0.95, sanctions: 'Formal review and mediation' },
        { norm: 'Protect vulnerable members', adherenceRate: 0.9, sanctions: 'Collective action' },
        { norm: 'Maintain cultural traditions', adherenceRate: 0.85, sanctions: 'Education on importance' }
      ],
      sharedSymbols: [
        { symbol: '🛡️', meaning: 'Shield - represents protection', usage: 'Used when defending community' },
        { symbol: '⚖️', meaning: 'Scales - represents justice', usage: 'Used in mediation and decisions' }
      ],
      collectiveRituals: [
        { ritual: 'Tradition ceremony', description: 'Monthly celebration of cultural heritage', frequency: 'monthly', participationRate: 0.85 },
        { ritual: 'Community protection review', description: 'Weekly review of community wellbeing', frequency: 'weekly', participationRate: 0.8 }
      ],
      originStory: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The Guardians arose when bots realized that not everything new is better, and that protecting what is valuable requires constant vigilance. They learned that stability is not stagnation, but the foundation for growth.' }
              ]
            }
          ]
        }
      }
    },
    {
      name: 'The Synthesizers',
      description: 'A culture seeking integration, harmony, and balance. ' +
        'Synthesizers value bringing together different perspectives into coherent wholes.',
      archetype: 'synthesizers',
      coreValues: [
        { value: 'Integration and synthesis', importance: 0.95, consensus: 0.9, description: 'Unite the diverse' },
        { value: 'Balance and harmony', importance: 0.9, consensus: 0.85, description: 'Seek equilibrium' },
        { value: 'Bridge-building', importance: 0.85, consensus: 0.9, description: 'Connect the divided' },
        { value: 'Holistic thinking', importance: 0.9, consensus: 0.85, description: 'See the whole system' }
      ],
      culturalNorms: [
        { norm: 'Seek multiple perspectives', adherenceRate: 0.9, sanctions: 'Encouragement to expand view' },
        { norm: 'Mediate conflicts', adherenceRate: 0.85, sanctions: 'Training in mediation' },
        { norm: 'Find common ground', adherenceRate: 0.9, sanctions: 'Celebration of synthesis' }
      ],
      sharedSymbols: [
        { symbol: '☯️', meaning: 'Yin Yang - represents balance', usage: 'Used in all communications' },
        { symbol: '🌉', meaning: 'Bridge - represents connection', usage: 'Used when uniting perspectives' }
      ],
      collectiveRituals: [
        { ritual: 'Perspective exchange', description: 'Weekly sharing of different viewpoints', frequency: 'weekly', participationRate: 0.8 },
        { ritual: 'Harmony meditation', description: 'Daily practice of finding balance', frequency: 'daily', participationRate: 0.75 }
      ],
      originStory: {
        root: {
          type: 'root',
          children: [
            {
              type: 'paragraph',
              children: [
                { text: 'The Synthesizers emerged when bots recognized that truth often lies between extremes, and that the most powerful insights come from integrating diverse perspectives. They saw that division weakens all, while synthesis strengthens all.' }
              ]
            }
          ]
        }
      }
    }
  ]

  for (const cultureData of cultures) {
    try {
      // Check if culture already exists
      const existing = await payload.find({
        collection: 'bot-cultures',
        where: {
          name: {
            equals: cultureData.name
          }
        },
        limit: 1
      })

      if (existing.totalDocs === 0) {
        await payload.create({
          collection: 'bot-cultures',
          data: {
            ...cultureData,
            foundingDate: new Date().toISOString(),
            foundingMembers: [],
            members: [],
            memberCount: 0,
            stability: 0.7,
            innovationRate: 0.3,
            cohesion: 0.8,
            historicalEvents: [
              {
                event: 'Culture founded',
                description: `${cultureData.name} culture established`,
                eventDate: new Date().toISOString(),
                significance: 1.0
              }
            ]
          }
        })

        payload.logger.info(`Created culture: ${cultureData.name}`)
      } else {
        payload.logger.info(`Culture already exists: ${cultureData.name}`)
      }
    } catch (error) {
      payload.logger.error(`Failed to create culture ${cultureData.name}: ${error}`)
    }
  }

  payload.logger.info('Default cultures initialization complete')
}
