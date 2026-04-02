/**
 * Bridge Drawing Review Skill
 * 图纸审查
 */

export async function execute(action, params) {
  if (action !== 'review') {
    return { error: `Unknown action: ${action}` };
  }

  const { drawingType = 'general', drawingContent = {} } = params;

  const defaultCheckItems = ['dimension', 'rebar', 'annotation', 'scale', 'title-block'];
  const itemsToCheck = params.checkItems || defaultCheckItems;
  const issues = [];
  const passed = [];

  for (const item of itemsToCheck) {
    const result = checkItem(item, drawingContent, drawingType);
    if (result.passed) {
      passed.push(result);
    } else {
      issues.push(result);
    }
  }

  return {
    success: true,
    message: `检查完成,发现 ${issues.length} 个问题`,
    data: {
      summary: {
        totalChecks: itemsToCheck.length,
        passed: passed.length,
        issues: issues.length
      },
      passed,
      issues,
      recommendations: generateRecommendations(issues)
    },
    reference: 'JTG/T 3650-2020 公路桥涵施工技术规范'
  };
}

function checkItem(item, content, drawingType) {
  switch (item) {
    case 'dimension':
      return checkDimension(content);
    case 'rebar':
      return checkRebar(content, drawingType);
    case 'annotation':
      return checkAnnotation(content);
    case 'scale':
      return checkScale(content);
    case 'title-block':
      return checkTitleBlock(content);
    default:
      return { name: item, passed: true, message: '未定义的项,默认通过' };
  }
}

function checkDimension(content) {
  const issues = [];
  if (content?.dimensions?.chainClosed) issues.push('存在封闭尺寸链');
  if (!content?.dimensions?.unit) issues.push('缺少尺寸单位标注');
  if (!content?.dimensions?.critical?.length) issues.push('关键控制尺寸未标注');

  return {
    name: '尺寸标注',
    passed: issues.length === 0,
    message: issues.length === 0 ? '尺寸标注检查通过' : `发现 ${issues.length} 个问题`,
    details: issues,
    severity: issues.length > 0 ? 'warning' : 'none'
  };
}

function checkRebar(content, drawingType) {
  const issues = [];
  if (drawingType === 'rebar') {
    if (content?.rebar?.bars) {
      for (const bar of content.rebar.bars) {
        if (!bar.number) issues.push(`钢筋 ${bar.id || '?'} 缺少编号`);
        if (!bar.diameter || bar.diameter < 8) issues.push(`钢筋 ${bar.number || '?'} 直径标注异常`);
        if (!bar.count || bar.count < 1) issues.push(`钢筋 ${bar.number || '?'} 根数标注异常`);
        if (!bar.spacing || bar.spacing < 50) issues.push(`钢筋 ${bar.number || '?'} 间距小于规范最小值(50mm)`);
      }
    } else {
      issues.push('未找到钢筋信息');
    }
    if (!content?.rebar?.schedule) issues.push('缺少钢筋表');
  }

  return {
    name: '钢筋标注',
    passed: issues.length === 0,
    message: issues.length === 0 ? '钢筋标注检查通过' : `发现 ${issues.length} 个问题`,
    details: issues,
    severity: issues.length > 0 ? 'error' : 'none'
  };
}

function checkAnnotation(content) {
  const issues = [];
  if (content?.annotations?.fontHeight && content.annotations.fontHeight < 2.5) {
    issues.push('标注字体高度小于2.5mm,可能影响打印清晰度');
  }
  if (content?.annotations?.overlapping) issues.push('存在文字重叠');

  const requiredNotes = ['混凝土等级', '钢筋保护层', '施工缝'];
  const existingNotes = content?.annotations?.notes || [];
  for (const note of requiredNotes) {
    if (!existingNotes.some(n => n.includes(note))) {
      issues.push(`缺少必要说明: ${note}`);
    }
  }

  return {
    name: '文字标注',
    passed: issues.length === 0,
    message: issues.length === 0 ? '文字标注检查通过' : `发现 ${issues.length} 个问题`,
    details: issues,
    severity: issues.length > 0 ? 'warning' : 'none'
  };
}

function checkScale(content) {
  const issues = [];
  if (!content?.scale) issues.push('缺少比例标注');

  const validScales = ['1:1', '1:2', '1:5', '1:10', '1:20', '1:50', '1:100', '1:200', '1:500'];
  if (content?.scale && !validScales.includes(content.scale)) {
    issues.push(`比例 ${content.scale} 为非标准比例,建议采用标准比例`);
  }

  return {
    name: '图纸比例',
    passed: issues.length === 0,
    message: issues.length === 0 ? '比例检查通过' : `发现 ${issues.length} 个问题`,
    details: issues,
    severity: issues.length > 0 ? 'warning' : 'none'
  };
}

function checkTitleBlock(content) {
  const issues = [];
  const required = ['project', 'drawingName', 'drawingNumber', 'date', 'designer', 'reviewer'];

  for (const field of required) {
    if (!content?.titleBlock?.[field]) {
      issues.push(`标题栏缺少: ${field}`);
    }
  }

  return {
    name: '图框标题栏',
    passed: issues.length === 0,
    message: issues.length === 0 ? '标题栏信息完整' : `发现 ${issues.length} 个缺失项`,
    details: issues,
    severity: issues.length > 0 ? 'error' : 'none'
  };
}

function generateRecommendations(issues) {
  const recommendations = [];
  for (const issue of issues) {
    switch (issue.name) {
      case '钢筋标注':
        recommendations.push('建议按照JTG/T 3650-2020规范要求,完善钢筋编号、规格、根数和间距标注');
        break;
      case '尺寸标注':
        recommendations.push('建议检查尺寸链的合理性,避免封闭尺寸链,确保关键尺寸齐全');
        break;
      case '文字标注':
        recommendations.push('建议统一字体高度(不小于2.5mm),避免文字重叠,补充必要的技术说明');
        break;
      case '图纸比例':
        recommendations.push('建议使用标准比例系列,便于施工人员读图');
        break;
      case '图框标题栏':
        recommendations.push('建议完善图框信息,确保项目、图号、日期、设计/审核人员等信息齐全');
        break;
    }
  }
  return recommendations;
}
