# Kaggle Routing Reference

**App name:** `kaggle`
**Base URL proxied:** `api.kaggle.com`

## API Path Pattern

Kaggle uses an RPC-style API with POST requests:

```
/kaggle/v1/{ServiceName}/{MethodName}
```

All requests are POST with JSON body.

## Datasets

### List Datasets

```bash
POST /kaggle/v1/datasets.DatasetApiService/ListDatasets
Content-Type: application/json

{}
```

Optional parameters: `search`, `user`, `pageSize`, `pageToken`

### Get Dataset

```bash
POST /kaggle/v1/datasets.DatasetApiService/GetDataset
Content-Type: application/json

{
  "ownerSlug": "username",
  "datasetSlug": "dataset-name"
}
```

### List Dataset Files

```bash
POST /kaggle/v1/datasets.DatasetApiService/ListDatasetFiles
Content-Type: application/json

{
  "ownerSlug": "username",
  "datasetSlug": "dataset-name"
}
```

### Get Dataset Metadata

```bash
POST /kaggle/v1/datasets.DatasetApiService/GetDatasetMetadata
Content-Type: application/json

{
  "ownerSlug": "username",
  "datasetSlug": "dataset-name"
}
```

### Download Dataset

```bash
POST /kaggle/v1/datasets.DatasetApiService/DownloadDataset
Content-Type: application/json

{
  "ownerSlug": "username",
  "datasetSlug": "dataset-name"
}
```

Returns binary ZIP file.

## Models

### List Models

```bash
POST /kaggle/v1/models.ModelApiService/ListModels
Content-Type: application/json

{}
```

Optional parameters: `owner`, `search`, `pageSize`

### Get Model

```bash
POST /kaggle/v1/models.ModelApiService/GetModel
Content-Type: application/json

{
  "ownerSlug": "google",
  "modelSlug": "gemma"
}
```

## Competitions

### List Competitions

```bash
POST /kaggle/v1/competitions.CompetitionApiService/ListCompetitions
Content-Type: application/json

{}
```

Optional parameters: `search`, `category`, `pageSize`

## Kernels (Notebooks)

### List Kernels

```bash
POST /kaggle/v1/kernels.KernelsApiService/ListKernels
Content-Type: application/json

{}
```

Optional parameters: `search`, `user`, `language`, `pageSize`

### Get Kernel

```bash
POST /kaggle/v1/kernels.KernelsApiService/GetKernel
Content-Type: application/json

{
  "userName": "username",
  "kernelSlug": "kernel-slug"
}
```

## Notes

- All requests use POST method with JSON body
- API follows RPC pattern: `/v1/{ServiceName}/{MethodName}`
- Dataset refs: `{owner}/{dataset-slug}`
- Model refs: `{owner}/{model-slug}`
- Kernel refs: `{user}/{kernel-slug}`
- Download endpoints return binary ZIP files
- Authentication uses Kaggle API key (managed via Maton connection)

## Resources

- [Kaggle API Documentation](https://www.kaggle.com/docs/api)
