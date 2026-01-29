#!/usr/bin/env node

const https = require('https');

const API_URL = 'https://skills.sh/api/skills';

async function fetchSkills() {
  return new Promise((resolve, reject) => {
    https.get(API_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function formatNumber(num) {
  return new Intl.NumberFormat().format(num);
}

async function main() {
  const args = process.argv.slice(2);
  const query = args[0];
  const popular = args.includes('--popular');
  const limitFlag = args.find(a => a.startsWith('--limit='));
  const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : 20;
  const showInstall = args.includes('--show-install');

  if (!query && !popular || query === '--help' || query === '-h') {
    console.log(`
Usage: skills-search <query> [options]
       skills-search --popular [options]

Options:
  --popular        Show most popular skills (sorted by installs)
  --limit=<n>      Limit results (default: 20)
  --show-install   Show npx skills add command
  --help, -h       Show this help

Examples:
  skills-search "web design"
  skills-search "postgres" --limit 5 --show-install
  skills-search --popular --limit 10

Learn more: https://skills.sh
    `);
    process.exit(query || popular ? 0 : 1);
  }

  const mode = popular ? 'popular' : 'search';
  console.log(`🔍 Showing ${mode} skills...\n`);

  try {
    const { skills } = await fetchSkills();
    let results = [];

    if (popular) {
      // Sort by installs (already sorted, but explicit)
      results = skills.slice(0, limit);
      console.log(`📈 Top ${limit} most popular skills:\n`);
    } else {
      results = skills
        .filter(s => 
          s.name.toLowerCase().includes(query.toLowerCase()) ||
          s.topSource.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, limit);
      console.log(`🔍 Searching skills.sh for "${query}"...\n`);
    }

    if (results.length === 0) {
      console.log(`❌ No skills found`);
      return;
    }

    results.forEach(skill => {
      console.log(`✅ ${skill.name} (${formatNumber(skill.installs)} installs)`);
      console.log(`   Source: ${skill.topSource}`);
      if (showInstall) {
        console.log(`   Install: npx skills add ${skill.topSource}`);
      }
      console.log('');
    });

    console.log(`📦 To publish your own skill:`);
    console.log(`   clawdhub publish ./your-skill/ --slug your-skill --name "Your Skill"`);
  } catch (e) {
    console.error(`❌ Error fetching skills: ${e.message}`);
    process.exit(1);
  }
}

main();
