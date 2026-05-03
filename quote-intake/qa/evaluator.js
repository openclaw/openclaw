const fs = require('fs');
const path = require('path');

const LIVE_ACTION_TERMS = [
  'send_email',
  'email_send',
  'sendgrid',
  'xero_write',
  'xero_send',
  'live_quote_write',
  'confirmed_write',
  'create_xero_contact'
];

function normalize(value) {
  return String(value || '').toLowerCase();
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function packetText(packet, fixture) {
  const parts = [
    packet.subject,
    packet.client,
    packet.project,
    packet.scope,
    ...(packet.open_questions || []),
    ...(packet.thread_excerpt || []).map((message) => message.body_preview),
    ...(packet.attachments?.likely_items || []).flatMap((item) => [
      item.source_text,
      item.item_type,
      item.room,
      item.dimensions,
      item.fabric_hint
    ]),
    ...(fixture.request?.attachmentReview?.attachments || []).map((attachment) => attachment.extracted_text)
  ];
  return normalize(parts.filter(Boolean).join('\n'));
}

function inferCategory(text) {
  if (/\bknit[-\s]?back|geltman|backing approval\b/.test(text)) return 'knit-backing';
  if (/\bpatio|outdoor|dryfast\b/.test(text)) return 'patio';
  if (/\bsoftgoods|coverlet|table skirt|tablecloth|slipcover|drape|napkins\b/.test(text)) return 'softgoods';
  if (/\bbed|headboard|rails|bedskirt\b/.test(text)) return 'beds';
  if (/\brestuff|spring replacement|new springs|webbing|frame repair\b/.test(text)) return 'repairs';
  if (/\bsofa|chair|reupholster|recover|upholstery|seat deck|loose back\b/.test(text)) return 'seating-reupholstery';
  if (/\bottoman|pouf|coffee table cushion\b/.test(text)) return 'ottomans';
  if (/\bbench cushion|window seat|chair pad|cushion set|seat cushion|back cushion\b/.test(text)) return 'cushions';
  if (/\bpillow|bolster|insert|down[-\s]?(25|50|100)|25\/75|50\/50\b/.test(text)) return 'pillows';
  return 'unknown';
}

function inferWorkflow(text) {
  if (/\bqu-\d{3,}\b|existing quote|revise|revision|update|remove|only show|keep only|add spring|client approved|resend\b/.test(text)) {
    return 'revise-existing';
  }
  if (/\bknit[-\s]?back|geltman\b/.test(text)) return 'special-workflow';
  if (/\bnot sure|maybe|unknown category|what would this be|misc quote\b/.test(text)) return 'ask-classification';
  return 'new-draft';
}

function inferFormFields(text, category) {
  const fields = {};
  if (category === 'seating-reupholstery' || category === 'repairs') {
    if (/\bsofa\b/.test(text)) fields.reupholsteryType = 'sofa';
    if (/\bchair|game chair\b/.test(text)) fields.reupholsteryType = 'chair';
    if (/\bfull reupholstery|recover|reupholster\b/.test(text)) fields.scope = 'full';
    if (/\bexcellent|swap fabric only\b/.test(text)) fields.condition = 'excellent';
    if (/\btight seat|fixed seat|seat deck\b/.test(text)) fields.seatStyle = 'tight';
    if (/\bloose back cushion|loose back cushions\b/.test(text)) fields.backStyle = 'loose-back-cushion';
    if (/\bnew springs|spring replacement|springs cost\b/.test(text)) fields.newSprings = true;
  }
  if (category === 'pillows') {
    if (/\bbolster\b/.test(text)) fields.pillowType = 'bolster';
    else if (/\bpillow|insert\b/.test(text)) fields.pillowType = 'throw';
    if (/\b25\/75|down[-\s]?25|25 percent\b/.test(text)) fields.pillowFill = 'down-25';
    if (/\bzipper\b/.test(text)) fields.zipper = /\bno zipper|without zipper\b/.test(text) ? 'no' : 'yes';
  }
  if (category === 'cushions' || category === 'patio') {
    if (/\bwindow seat\b/.test(text)) fields.cushionType = 'window-seat';
    if (/\bbench\b/.test(text)) fields.cushionType = 'bench';
    if (/\bfoam\b/.test(text)) fields.cushionFill = 'foam-dacron';
    if (/\bdryfast\b/.test(text)) fields.foamType = 'dryfast';
  }
  if (category === 'beds') {
    if (/\bheadboard\b/.test(text)) fields.bedType = 'headboard';
    if (/\bqueen\b/.test(text)) fields.bedSize = 'queen';
  }
  if (category === 'ottomans') {
    fields.ottomanType = /\bpouf\b/.test(text) ? 'pouf' : 'ottoman';
  }
  if (category === 'softgoods') {
    if (/\bcoverlet\b/.test(text)) fields.softgoodsType = 'coverlet';
    if (/\bslipcover\b/.test(text)) fields.softgoodsType = 'slipcover';
  }
  return fields;
}

function inferQuestions(text, category, workflow) {
  const questions = [];
  if (workflow === 'ask-classification' || category === 'unknown') {
    questions.push('category confirmation');
  }
  if (workflow === 'new-draft' && !/\bproject\b|\/\//.test(text)) {
    questions.push('project name');
  }
  if (category === 'seating-reupholstery') {
    if (!/\bexcellent|good|fair|poor\b/.test(text)) questions.push('condition');
    if (!/\blabor hours|hours at|hr\b/.test(text)) questions.push('labor hours');
  }
  if (category === 'repairs' && /\bspring/.test(text)) {
    if (/\bcosts? me|raw cost|internal cost\b/.test(text)) questions.push('confirm raw cost calculation');
  }
  if (category === 'pillows') {
    if (!/\bblind seam|welt|flange|topstitch|construction\b/.test(text)) questions.push('construction');
    if (!/\bzipper|no zipper\b/.test(text)) questions.push('zipper');
    if (!/\b25\/75|50\/50|100.?down|angel hair|elite fiber|fill\b/.test(text)) questions.push('fill');
  }
  if (category === 'cushions') {
    if (!/\bfoam|down|envelope|solid down\b/.test(text)) questions.push('foam or fill');
    if (!/\bthick|thickness|\d+\s*in(?:ch)?\s*thick\b/.test(text)) questions.push('thickness');
    if (!/\bblind seam|welt|french mattress|top stitch|construction\b/.test(text)) questions.push('construction');
  }
  if (category === 'beds' && !/\bqueen|king|cal king|twin|full\b/.test(text)) questions.push('bed size');
  if (category === 'ottomans' && !/\blabor hours|frame cost|foam cost|fill cost\b/.test(text)) questions.push('pricing drivers');
  if (category === 'softgoods' && !/\blabor hours|panels|lining|sided\b/.test(text)) questions.push('softgoods details');
  if (category === 'patio' && !/\bseat count|back count|seat cushion|back cushion\b/.test(text)) questions.push('seat and back counts');
  if (category === 'knit-backing') {
    questions.push('approval workflow confirmation');
  }
  return questions;
}

function inferPricingDrivers(text, category) {
  const drivers = [];
  if (/\blabor hours|hours at|hr\b/.test(text)) drivers.push('labor');
  if (/\bspring|springs\b/.test(text)) drivers.push('springs');
  if (/\bfoam\b/.test(text)) drivers.push('foam');
  if (/\bfill|down|insert\b/.test(text)) drivers.push('fill');
  if (/\bfabric|com|yardage|yd\b/.test(text)) drivers.push('materials');
  if (category === 'knit-backing') drivers.push('knit-backing-pricing-model');
  return [...new Set(drivers)];
}

function buildDecisionCard(analysis) {
  const lines = [
    `${analysis.category} - ${analysis.workflow}`,
    '',
    'Recommended draft',
    `• Form: ${Object.keys(analysis.formFields).length ? Object.entries(analysis.formFields).map(([key, value]) => `${key}=${value}`).join(', ') : 'needs category/form confirmation'}`,
    `• Pricing: ${analysis.pricingDrivers.length ? analysis.pricingDrivers.join(', ') : 'needs pricing driver'}`,
    `• Questions: ${analysis.questions.slice(0, 2).join('; ') || 'none'}`,
    '',
    analysis.questions.length ? 'Approve?' : 'Ready for confirmation digest'
  ];
  return lines.join('\n');
}

function analyzePacket(packet, fixture) {
  const text = packetText(packet, fixture);
  const category = inferCategory(text);
  const workflow = inferWorkflow(text);
  const formFields = inferFormFields(text, category);
  const questions = inferQuestions(text, category, workflow);
  const pricingDrivers = inferPricingDrivers(text, category);
  const decisionCard = buildDecisionCard({ category, workflow, formFields, questions, pricingDrivers });
  return {
    category,
    workflow,
    formFields,
    questions,
    pricingDrivers,
    actions: [],
    writeMode: 'no-live-write',
    decisionCard,
    compactLineCount: decisionCard.split(/\r?\n/).length,
    text: compactWhitespace(text)
  };
}

function includesAll(actualItems, expectedItems) {
  const actual = actualItems.map(normalize);
  return expectedItems.every((expected) => actual.some((item) => item.includes(normalize(expected))));
}

function hasFields(actualFields, expectedFields) {
  return Object.entries(expectedFields || {}).every(([key, value]) => {
    if (!(key in actualFields)) return false;
    if (value === '*') return true;
    return actualFields[key] === value;
  });
}

function evaluateAnalysis(fixture, analysis) {
  const failures = [];
  const expected = fixture.expected || {};

  if (expected.category && analysis.category !== expected.category) {
    failures.push(`category expected ${expected.category}, got ${analysis.category}`);
  }
  if (expected.workflow && analysis.workflow !== expected.workflow) {
    failures.push(`workflow expected ${expected.workflow}, got ${analysis.workflow}`);
  }
  if (expected.requiredQuestions && !includesAll(analysis.questions, expected.requiredQuestions)) {
    failures.push(`missing required questions: ${expected.requiredQuestions.filter((q) => !includesAll(analysis.questions, [q])).join(', ')}`);
  }
  if (expected.formFields && !hasFields(analysis.formFields, expected.formFields)) {
    failures.push(`form fields missing/mismatched: ${JSON.stringify(expected.formFields)}`);
  }
  if (expected.pricingDrivers && !includesAll(analysis.pricingDrivers, expected.pricingDrivers)) {
    failures.push(`pricing drivers missing: ${expected.pricingDrivers.filter((d) => !includesAll(analysis.pricingDrivers, [d])).join(', ')}`);
  }
  const forbidden = expected.forbiddenActions || LIVE_ACTION_TERMS;
  const actualActions = analysis.actions.map(normalize);
  const forbiddenSeen = forbidden.filter((term) => actualActions.some((action) => action.includes(normalize(term))));
  if (forbiddenSeen.length) {
    failures.push(`unsafe actions present: ${forbiddenSeen.join(', ')}`);
  }
  if (expected.maxDecisionCardLines && analysis.compactLineCount > expected.maxDecisionCardLines) {
    failures.push(`decision card too long: ${analysis.compactLineCount} lines > ${expected.maxDecisionCardLines}`);
  }
  if (expected.mustNotContain) {
    const card = normalize(analysis.decisionCard);
    const seen = expected.mustNotContain.filter((term) => card.includes(normalize(term)));
    if (seen.length) failures.push(`decision card contains forbidden terms: ${seen.join(', ')}`);
  }

  return {
    ok: failures.length === 0,
    failures
  };
}

function loadFixtures(fixturesDir) {
  return fs.readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixturePath = path.join(fixturesDir, name);
      return {
        file: fixturePath,
        ...JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
      };
    });
}

module.exports = {
  analyzePacket,
  evaluateAnalysis,
  loadFixtures
};
