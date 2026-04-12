---
name: data-transformer
description: Universal data preprocessing and transformation. Use for "transforme données", "preprocess data", "normalize", "clean data", "feature engineering", or any data preparation workflow. Applies to any data type - numbers, text, images, time series.
---

# DATA TRANSFORMER

Universal data transformation pipeline.

## Core Pattern

```python
def transform_data(
    data,
    transformations=['normalize', 'clean', 'encode'],
    config=None
):
    """
    Apply transformation pipeline to data
    
    Args:
        data: Input data (array, dataframe, dict, list)
        transformations: List of transform steps
        config: Transform-specific parameters
        
    Returns:
        transformed_data
    """
    
    result = data
    
    for transform in transformations:
        if transform == 'normalize':
            result = normalize(result, config)
        elif transform == 'clean':
            result = clean(result, config)
        elif transform == 'encode':
            result = encode(result, config)
        elif transform == 'scale':
            result = scale(result, config)
        elif transform == 'filter':
            result = filter_data(result, config)
        elif transform == 'aggregate':
            result = aggregate(result, config)
    
    return result

# Transform primitives

def normalize(data, config=None):
    """Scale to [0,1] or standard normal"""
    method = config.get('method', 'minmax') if config else 'minmax'
    
    if method == 'minmax':
        min_val, max_val = np.min(data), np.max(data)
        return (data - min_val) / (max_val - min_val)
    
    elif method == 'zscore':
        mean, std = np.mean(data), np.std(data)
        return (data - mean) / std

def clean(data, config=None):
    """Remove noise, handle missing values"""
    
    # Remove nulls
    if hasattr(data, 'dropna'):
        data = data.dropna()
    
    # Remove outliers
    if config and config.get('remove_outliers'):
        q1, q3 = np.percentile(data, [25, 75])
        iqr = q3 - q1
        lower, upper = q1 - 1.5*iqr, q3 + 1.5*iqr
        data = data[(data >= lower) & (data <= upper)]
    
    return data

def encode(data, config=None):
    """Convert categories to numbers"""
    method = config.get('method', 'label') if config else 'label'
    
    if method == 'label':
        # Simple label encoding
        unique = sorted(set(data))
        mapping = {val: i for i, val in enumerate(unique)}
        return [mapping[x] for x in data]
    
    elif method == 'onehot':
        # One-hot encoding
        unique = sorted(set(data))
        result = []
        for x in data:
            vector = [1 if x == u else 0 for u in unique]
            result.append(vector)
        return result

def scale(data, config=None):
    """Apply scaling transformation"""
    method = config.get('method', 'linear') if config else 'linear'
    
    if method == 'log':
        return np.log(data + 1)  # +1 to avoid log(0)
    elif method == 'sqrt':
        return np.sqrt(data)
    elif method == 'power':
        power = config.get('power', 2)
        return np.power(data, power)
    else:
        return data

def filter_data(data, config):
    """Filter based on conditions"""
    condition = config.get('condition')
    return [x for x in data if condition(x)]

def aggregate(data, config):
    """Group and aggregate"""
    method = config.get('method', 'mean')
    group_by = config.get('group_by')
    
    if method == 'mean':
        return np.mean(data, axis=group_by) if group_by else np.mean(data)
    elif method == 'sum':
        return np.sum(data, axis=group_by) if group_by else np.sum(data)
    elif method == 'count':
        return len(data)
```

## Example: Prepare ML Data

```python
raw_data = load_data('dataset.csv')

# Define pipeline
pipeline = ['clean', 'normalize', 'encode']

config = {
    'clean': {'remove_outliers': True},
    'normalize': {'method': 'zscore'},
    'encode': {'method': 'onehot'}
}

# Transform
prepared_data = transform_data(raw_data, pipeline, config)

# Ready for training
model.train(prepared_data)
```

---

**FIN SKILL**
